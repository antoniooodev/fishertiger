"""Runtime Serie A availability snapshots backed by API-Football."""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
from collections.abc import Callable
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from rapidfuzz import fuzz

from .pipeline import normalize
from .player_list_updates import active_player_list_path, read_player_list, season_years


API_BASE = "https://v3.football.api-sports.io"
TTL_SECONDS = 4 * 60 * 60
MAX_RESPONSE_BYTES = 10_000_000
FUZZY_THRESHOLD = 90.0
FUZZY_MARGIN = 7.0
FetchJson = Callable[[str, str], object]
_LOCKS: dict[Path, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()

TEAM_ALIASES = {
    "ac milan": "milan",
    "ac monza": "monza",
    "acf fiorentina": "fiorentina",
    "as roma": "roma",
    "bologna fc": "bologna",
    "cagliari calcio": "cagliari",
    "como 1907": "como",
    "genoa cfc": "genoa",
    "hellas verona": "verona",
    "inter milan": "inter",
    "internazionale": "inter",
    "internazionale milano": "inter",
    "juventus fc": "juventus",
    "parma calcio 1913": "parma",
    "ss lazio": "lazio",
    "ssc napoli": "napoli",
    "torino fc": "torino",
    "udinese calcio": "udinese",
    "us lecce": "lecce",
    "us sassuolo calcio": "sassuolo",
}


class InjuryUpdateError(ValueError):
    """The provider response, player source, or stored snapshot is invalid."""


class InjuryCoverageUnsupported(InjuryUpdateError):
    """The selected competition season does not publish injury data."""


def provider_season(season: str) -> int:
    return season_years(season)[0]


def _clean_text(value: object, limit: int = 500) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", value).strip()[:limit]


def fetch_json(url: str, api_key: str) -> object:
    request = Request(
        url,
        headers={"x-apisports-key": api_key, "User-Agent": "Fishertiger/1.0"},
    )
    try:
        with urlopen(request, timeout=20) as response:
            if response.status != 200:
                raise InjuryUpdateError(f"API-Football returned HTTP {response.status}.")
            payload = response.read(MAX_RESPONSE_BYTES + 1)
            if len(payload) > MAX_RESPONSE_BYTES:
                raise InjuryUpdateError("API-Football returned an unexpectedly large response.")
    except InjuryUpdateError:
        raise
    except Exception as error:
        raise InjuryUpdateError("API-Football could not be reached.") from error
    try:
        return json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise InjuryUpdateError("API-Football returned invalid JSON.") from error


def _provider_response(payload: object, endpoint: str) -> list[object]:
    if not isinstance(payload, dict) or not isinstance(payload.get("response"), list):
        raise InjuryUpdateError(f"API-Football returned an invalid {endpoint} payload.")
    errors = payload.get("errors")
    if errors not in (None, [], {}) and bool(errors):
        raise InjuryUpdateError(f"API-Football rejected the {endpoint} request.")
    return payload["response"]


def resolve_serie_a(payload: object, season: int) -> tuple[int, bool]:
    matches: list[tuple[int, bool]] = []
    for item in _provider_response(payload, "leagues"):
        if not isinstance(item, dict):
            continue
        league, country, seasons = item.get("league"), item.get("country"), item.get("seasons")
        if not isinstance(league, dict) or not isinstance(country, dict) or not isinstance(seasons, list):
            continue
        if _clean_text(league.get("name")) != "Serie A" or _clean_text(country.get("name")) != "Italy":
            continue
        league_id = league.get("id")
        if isinstance(league_id, bool) or not isinstance(league_id, int):
            continue
        selected = [entry for entry in seasons if isinstance(entry, dict) and entry.get("year") == season]
        if len(selected) == 1 and isinstance(selected[0].get("coverage"), dict):
            matches.append((league_id, selected[0]["coverage"].get("injuries") is True))
    if len(matches) != 1:
        raise InjuryUpdateError("API-Football did not return one exact Italy / Serie A competition.")
    return matches[0]


def _team_key(value: object) -> str:
    key = normalize(value)
    return TEAM_ALIASES.get(key, key)


def _name_score(provider_name: str, candidate_name: str) -> float:
    provider = normalize(provider_name)
    candidate = normalize(candidate_name)
    if not provider or not candidate:
        return 0.0
    if provider == candidate or sorted(provider.split()) == sorted(candidate.split()):
        return 100.0
    score = max(fuzz.WRatio(provider, candidate), fuzz.token_sort_ratio(provider, candidate))
    provider_tokens = provider.replace("-", " ").split()
    candidate_tokens = candidate.replace("-", " ").split()
    long_candidate = [token for token in candidate_tokens if len(token) > 3]
    short_candidate = [token for token in candidate_tokens if len(token) <= 3]
    remaining = provider_tokens.copy()
    for token in long_candidate:
        if token not in remaining:
            break
        remaining.remove(token)
    else:
        if short_candidate and len(short_candidate) <= len(remaining) and all(
            any(other.startswith(token) for other in remaining) for token in short_candidate
        ):
            score = max(score, 96.0)
    return float(score)


def match_player(
    provider_name: str,
    provider_team: str,
    players: list[dict[str, object]],
) -> dict[str, object]:
    team_key = _team_key(provider_team)
    team_matches = sorted({str(player["Squadra"]) for player in players if _team_key(player["Squadra"]) == team_key})
    if len(team_matches) != 1:
        return {"matched": False, "reason": "team_unmatched" if not team_matches else "team_ambiguous"}
    team = team_matches[0]
    candidates = [player for player in players if str(player["Squadra"]) == team]
    exact = [player for player in candidates if _name_score(provider_name, str(player["Nome"])) == 100]
    if len(exact) == 1:
        return {"matched": True, "player": exact[0], "method": "exact", "score": 100.0}
    if len(exact) > 1:
        return {"matched": False, "reason": "player_ambiguous", "candidates": [int(item["Id"]) for item in exact]}
    ranked = sorted(
        ((_name_score(provider_name, str(player["Nome"])), player) for player in candidates),
        key=lambda item: item[0],
        reverse=True,
    )
    best_score, best = ranked[0] if ranked else (0.0, None)
    second_score = ranked[1][0] if len(ranked) > 1 else 0.0
    if best is not None and best_score >= FUZZY_THRESHOLD and best_score - second_score >= FUZZY_MARGIN:
        return {"matched": True, "player": best, "method": "fuzzy_unique", "score": round(best_score, 1)}
    return {
        "matched": False,
        "reason": "player_ambiguous" if best_score >= FUZZY_THRESHOLD else "player_unmatched",
        "best_score": round(best_score, 1),
        "second_score": round(second_score, 1),
    }


def _context(item: dict[str, object]) -> dict[str, object]:
    fixture = item.get("fixture") if isinstance(item.get("fixture"), dict) else {}
    return {
        "fixture_id": fixture.get("id") if isinstance(fixture.get("id"), int) else None,
        "fixture_date": _clean_text(fixture.get("date"), 80) or None,
    }


def normalize_injuries(payload: object, players: list[dict[str, object]]) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    resolved: dict[int, dict[str, object]] = {}
    unresolved: list[dict[str, object]] = []
    for raw in _provider_response(payload, "injuries"):
        if not isinstance(raw, dict):
            raise InjuryUpdateError("API-Football returned an invalid injury record.")
        player = raw.get("player")
        team = raw.get("team")
        if not isinstance(player, dict) or not isinstance(team, dict):
            raise InjuryUpdateError("API-Football returned an invalid injury record.")
        player_id, team_id = player.get("id"), team.get("id")
        player_name, team_name = _clean_text(player.get("name"), 200), _clean_text(team.get("name"), 200)
        provider_type, reason = _clean_text(player.get("type"), 100), _clean_text(player.get("reason"))
        if (
            isinstance(player_id, bool) or not isinstance(player_id, int)
            or isinstance(team_id, bool) or not isinstance(team_id, int)
            or not player_name or not team_name
        ):
            raise InjuryUpdateError("API-Football returned an invalid injury record.")
        base = {
            "provider_player_id": player_id,
            "provider_player_name": player_name,
            "provider_team_id": team_id,
            "provider_team_name": team_name,
            "provider_type": provider_type,
            "reason": reason,
            **_context(raw),
        }
        availability = {"Missing Fixture": "OUT", "Questionable": "QUESTIONABLE"}.get(provider_type)
        if availability is None:
            unresolved.append({**base, "match_failure": "unsupported_availability_type"})
            continue
        match = match_player(player_name, team_name, players)
        if not match["matched"]:
            unresolved.append({**base, "match_failure": match["reason"], **{key: value for key, value in match.items() if key not in {"matched", "reason"}}})
            continue
        candidate = match["player"]
        normalized = {
            **base,
            "fantacalcio_id": int(candidate["Id"]),
            "fantacalcio_name": str(candidate["Nome"]),
            "fantacalcio_team": str(candidate["Squadra"]),
            "role": str(candidate["R"]),
            "availability": availability,
            "cause": "SUSPENSION" if re.search(r"suspend|squalific", reason, re.IGNORECASE) else "UNAVAILABILITY",
            "match_method": match["method"],
            "match_score": match["score"],
            "source": "api-football",
            "provider_contexts": [{"provider_type": provider_type, "reason": reason, **_context(raw)}],
        }
        identity = int(candidate["Id"])
        existing = resolved.get(identity)
        if existing is None:
            resolved[identity] = normalized
            continue
        existing["provider_contexts"].extend(normalized["provider_contexts"])
        stronger = existing["availability"] == "QUESTIONABLE" and availability == "OUT"
        nearer = (
            existing["availability"] == availability
            and normalized["fixture_date"] is not None
            and (existing["fixture_date"] is None or normalized["fixture_date"] < existing["fixture_date"])
        )
        if stronger or nearer:
            contexts = existing["provider_contexts"]
            resolved[identity] = {**normalized, "provider_contexts": contexts}
    return (
        sorted(resolved.values(), key=lambda item: (item["availability"], item["fantacalcio_team"], item["fantacalcio_name"])),
        unresolved,
    )


def snapshot_directory(root: Path, profile_id: str, season: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", profile_id):
        raise InjuryUpdateError("The profile ID is invalid.")
    start, end = season_years(season)
    return root / profile_id / f"{start}-{str(end)[-2:]}" / "injuries-v1"


@contextmanager
def _snapshot_transaction(directory: Path):
    with _LOCKS_GUARD:
        lock = _LOCKS.setdefault(directory.resolve(), threading.Lock())
    with lock:
        yield


def _snapshot_path(root: Path, profile_id: str, season: str) -> Path:
    return snapshot_directory(root, profile_id, season) / "latest.json"


def _read_snapshot(path: Path, season: str) -> dict[str, object] | None:
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise InjuryUpdateError("The stored injury snapshot is invalid.") from error
    if (
        not isinstance(value, dict)
        or value.get("schema_version") != "1.0"
        or value.get("provider") != "api-football"
        or value.get("season") != season
        or not isinstance(value.get("checked_at"), str)
        or not isinstance(value.get("players"), list)
        or not isinstance(value.get("unresolved"), list)
        or not isinstance(value.get("summary"), dict)
    ):
        raise InjuryUpdateError("The stored injury snapshot is invalid.")
    canonical = json.dumps(
        {"players": value["players"], "unresolved": value["unresolved"]},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    if value.get("content_hash") != hashlib.sha256(canonical.encode()).hexdigest():
        raise InjuryUpdateError("The stored injury snapshot failed its integrity check.")
    return value


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
            json.dump(value, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            temporary = Path(handle.name)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _age(snapshot: dict[str, object] | None, now: datetime) -> float | None:
    if snapshot is None:
        return None
    try:
        checked = datetime.fromisoformat(str(snapshot["checked_at"]).replace("Z", "+00:00"))
        if checked.tzinfo is None:
            checked = checked.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        raise InjuryUpdateError("The stored injury snapshot has an invalid timestamp.")
    return max(0.0, (now - checked.astimezone(timezone.utc)).total_seconds())


def stored_status(
    root: Path,
    profile_id: str,
    season: str,
    *,
    api_key: str | None = None,
    now: datetime | None = None,
) -> dict[str, object]:
    configured = bool((api_key if api_key is not None else os.environ.get("API_FOOTBALL_KEY", "")).strip())
    moment = now or datetime.now(timezone.utc)
    path = _snapshot_path(root, profile_id, season)
    with _snapshot_transaction(path.parent):
        snapshot = _read_snapshot(path, season)
    age = _age(snapshot, moment)
    state = "unconfigured" if not configured else "never_checked" if snapshot is None else "fresh" if age <= TTL_SECONDS else "stale"
    return {
        "state": state,
        "configured": configured,
        "fresh": age is not None and age <= TTL_SECONDS,
        "cache_age_seconds": round(age) if age is not None else None,
        "ttl_seconds": TTL_SECONDS,
        "snapshot": snapshot,
        "warning": None,
    }


def _active_players(profile: object) -> list[dict[str, object]]:
    frame, ceduti = read_player_list(active_player_list_path(profile))
    active = frame.loc[~frame["Id"].isin(set(ceduti["Id"]))]
    return [
        {"Id": int(row.Id), "R": str(row.R), "Nome": str(row.Nome), "Squadra": str(row.Squadra)}
        for row in active.itertuples()
    ]


def check_updates(
    root: Path,
    profile: object,
    fetcher: FetchJson = fetch_json,
    *,
    api_key: str | None = None,
    now: datetime | None = None,
) -> dict[str, object]:
    season = profile.season.season
    key = (api_key if api_key is not None else os.environ.get("API_FOOTBALL_KEY", "")).strip()
    if not key:
        return stored_status(root, profile.profile_id, season, api_key="", now=now)
    moment = now or datetime.now(timezone.utc)
    path = _snapshot_path(root, profile.profile_id, season)
    with _snapshot_transaction(path.parent):
        previous = _read_snapshot(path, season)
        try:
            year = provider_season(season)
            leagues_url = f"{API_BASE}/leagues?{urlencode({'country': 'Italy', 'season': year, 'name': 'Serie A'})}"
            league_id, coverage = resolve_serie_a(fetcher(leagues_url, key), year)
            if not coverage:
                raise InjuryCoverageUnsupported("API-Football injury coverage is unavailable for this Serie A season.")
            injuries_url = f"{API_BASE}/injuries?{urlencode({'league': league_id, 'season': year})}"
            players, unresolved = normalize_injuries(fetcher(injuries_url, key), _active_players(profile))
            canonical = json.dumps({"players": players, "unresolved": unresolved}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            snapshot = {
                "schema_version": "1.0",
                "provider": "api-football",
                "season": season,
                "provider_season": year,
                "league_id": league_id,
                "checked_at": moment.isoformat(),
                "content_hash": hashlib.sha256(canonical.encode()).hexdigest(),
                "players": players,
                "unresolved": unresolved,
                "summary": {
                    "out": sum(item["availability"] == "OUT" for item in players),
                    "questionable": sum(item["availability"] == "QUESTIONABLE" for item in players),
                    "unresolved": len(unresolved),
                },
            }
            _write_json(path, snapshot)
        except InjuryCoverageUnsupported as error:
            return {
                **_status_for_snapshot(previous, True, moment, "unsupported"),
                "warning": str(error),
            }
        except (ValueError, OSError) as error:
            return {
                **_status_for_snapshot(previous, True, moment, "error"),
                "warning": str(error),
            }
    return _status_for_snapshot(snapshot, True, moment, "fresh")


def _status_for_snapshot(
    snapshot: dict[str, object] | None,
    configured: bool,
    now: datetime,
    state: str,
) -> dict[str, object]:
    age = _age(snapshot, now)
    return {
        "state": state,
        "configured": configured,
        "fresh": state == "fresh",
        "cache_age_seconds": round(age) if age is not None else None,
        "ttl_seconds": TTL_SECONDS,
        "snapshot": snapshot,
        "warning": None,
    }
