import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from advisor.generate import load_profile
from advisor.injury_updates import (
    TTL_SECONDS,
    InjuryUpdateError,
    check_updates,
    fetch_json,
    match_player,
    normalize_injuries,
    provider_season,
    resolve_serie_a,
    stored_status,
)
from advisor.pipeline import LISTONE_COLUMNS


NOW = datetime(2026, 9, 18, 12, tzinfo=timezone.utc)


def league_payload(coverage=True, *, duplicate=False):
    item = {
        "league": {"id": 135, "name": "Serie A"},
        "country": {"name": "Italy"},
        "seasons": [{"year": 2026, "coverage": {"injuries": coverage}}],
    }
    return {"errors": [], "response": [item, item] if duplicate else [item]}


def injury(player_id=10, name="Mario Rossi", team="AC Milan", kind="Missing Fixture", reason="Muscle injury", fixture=1):
    return {
        "player": {"id": player_id, "name": name, "type": kind, "reason": reason},
        "team": {"id": 20, "name": team},
        "fixture": {"id": fixture, "date": "2026-09-20T18:00:00+00:00"},
    }


def players():
    return [
        {"Id": 1, "R": "A", "Nome": "Rossi Mario", "Squadra": "Milan"},
        {"Id": 2, "R": "C", "Nome": "Martinez Jo.", "Squadra": "Inter"},
        {"Id": 3, "R": "D", "Nome": "Bianchi Luca", "Squadra": "Milan"},
    ]


def profile_with_list(tmp_path: Path):
    value = json.loads((Path(__file__).parents[1] / "config/default_profile.json").read_text())
    value["profile_id"] = "injury-test"
    list_path = tmp_path / "listone.xlsx"
    defaults = {column: 0 for column in LISTONE_COLUMNS}
    rows = [
        {**defaults, "Id": 1, "R": "A", "RM": "Pc", "Nome": "Rossi Mario", "Squadra": "Milan"},
        {**defaults, "Id": 2, "R": "C", "RM": "C", "Nome": "Martinez Jo.", "Squadra": "Inter"},
    ]
    with pd.ExcelWriter(list_path, engine="openpyxl") as workbook:
        pd.DataFrame([["Quotazioni Fantacalcio Stagione 2026 27"]]).to_excel(workbook, sheet_name="Tutti", index=False, header=False)
        pd.DataFrame(rows, columns=sorted(LISTONE_COLUMNS)).to_excel(workbook, sheet_name="Tutti", index=False, startrow=1)
        pd.DataFrame([["Quotazioni Fantacalcio Stagione 2026 27"]]).to_excel(workbook, sheet_name="Ceduti", index=False, header=False)
        pd.DataFrame({"Id": []}).to_excel(workbook, sheet_name="Ceduti", index=False, startrow=1)
    next(source for source in value["current_sources"] if source["name"] == "player_list")["path"] = str(list_path)
    return load_profile(value)


def successful_fetcher(url, _key):
    if "/leagues?" in url:
        return league_payload()
    return {"errors": [], "response": [injury()]}


def test_missing_key_and_season_conversion(tmp_path):
    assert provider_season("2026/27") == 2026
    status = stored_status(tmp_path, "test", "2026/27", api_key="", now=NOW)
    assert status["state"] == "unconfigured"
    assert status["snapshot"] is None


def test_invalid_provider_json_is_rejected(monkeypatch):
    class Response:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, _limit):
            return b"not-json"

    monkeypatch.setattr("advisor.injury_updates.urlopen", lambda *_args, **_kwargs: Response())
    try:
        fetch_json("https://example.invalid", "secret")
    except InjuryUpdateError as error:
        assert "invalid JSON" in str(error)
    else:
        raise AssertionError("invalid JSON was accepted")


def test_exact_serie_a_resolution_requires_one_match_and_reports_coverage():
    assert resolve_serie_a(league_payload(), 2026) == (135, True)
    assert resolve_serie_a(league_payload(False), 2026) == (135, False)
    try:
        resolve_serie_a(league_payload(duplicate=True), 2026)
    except ValueError as error:
        assert "one exact" in str(error)
    else:
        raise AssertionError("ambiguous competition was accepted")


def test_normalizes_types_matches_and_detects_suspension():
    payload = {"response": [
        injury(kind="Missing Fixture"),
        injury(11, "José Martínez", "Internazionale", "Questionable", "Suspended one match", 2),
    ]}
    resolved, unresolved = normalize_injuries(payload, players())
    assert unresolved == []
    assert [(item["fantacalcio_id"], item["availability"]) for item in resolved] == [(1, "OUT"), (2, "QUESTIONABLE")]
    assert resolved[1]["cause"] == "SUSPENSION"
    assert resolved[1]["match_method"] == "fuzzy_unique"


def test_ambiguous_and_unmatched_identities_are_never_guessed():
    candidates = players() + [
        {"Id": 4, "R": "A", "Nome": "Rossi M.", "Squadra": "Milan"},
        {"Id": 5, "R": "A", "Nome": "Rossi Ma.", "Squadra": "Milan"},
    ]
    ambiguous = match_player("Marco Rossi", "AC Milan", candidates)
    assert not ambiguous["matched"]
    assert ambiguous["reason"] == "player_ambiguous"
    assert match_player("Nobody", "Unknown FC", candidates)["reason"] == "team_unmatched"
    assert match_player("Nobody", "AC Milan", candidates)["reason"] == "player_unmatched"


def test_duplicate_provider_entries_keep_context_and_prefer_out():
    payload = {"response": [
        injury(kind="Questionable", fixture=1),
        injury(kind="Missing Fixture", fixture=2),
    ]}
    resolved, _ = normalize_injuries(payload, players())
    assert len(resolved) == 1
    assert resolved[0]["availability"] == "OUT"
    assert len(resolved[0]["provider_contexts"]) == 2


def test_check_persists_atomically_and_status_obeys_ttl(tmp_path):
    profile = profile_with_list(tmp_path)
    result = check_updates(tmp_path / "updates", profile, successful_fetcher, api_key="secret", now=NOW)
    assert result["state"] == "fresh"
    assert result["snapshot"]["summary"] == {"out": 1, "questionable": 0, "unresolved": 0}
    directory = tmp_path / "updates" / "injury-test" / "2026-27" / "injuries-v1"
    assert json.loads((directory / "latest.json").read_text())["league_id"] == 135
    assert list(directory.iterdir()) == [directory / "latest.json"]
    fresh = stored_status(tmp_path / "updates", "injury-test", "2026/27", api_key="secret", now=NOW + timedelta(seconds=TTL_SECONDS))
    stale = stored_status(tmp_path / "updates", "injury-test", "2026/27", api_key="secret", now=NOW + timedelta(seconds=TTL_SECONDS + 1))
    assert fresh["state"] == "fresh"
    assert stale["state"] == "stale"


def test_coverage_false_does_not_query_injuries_or_write_snapshot(tmp_path):
    profile = profile_with_list(tmp_path)
    calls = []
    result = check_updates(
        tmp_path / "updates",
        profile,
        lambda url, _key: calls.append(url) or league_payload(False),
        api_key="secret",
        now=NOW,
    )
    assert result["state"] == "unsupported"
    assert len(calls) == 1
    assert result["snapshot"] is None


def test_api_and_invalid_payload_failures_preserve_previous_snapshot(tmp_path):
    profile = profile_with_list(tmp_path)
    root = tmp_path / "updates"
    previous = check_updates(root, profile, successful_fetcher, api_key="secret", now=NOW)["snapshot"]

    def api_error(url, _key):
        return league_payload() if "/leagues?" in url else {"errors": {"limit": "reached"}, "response": []}

    failed = check_updates(root, profile, api_error, api_key="secret", now=NOW + timedelta(hours=5))
    assert failed["state"] == "error"
    assert failed["snapshot"] == previous
    assert json.loads(next(root.rglob("latest.json")).read_text()) == previous

    invalid = check_updates(root, profile, lambda _url, _key: {"bad": True}, api_key="secret", now=NOW + timedelta(hours=6))
    assert invalid["state"] == "error"
    assert invalid["snapshot"] == previous
