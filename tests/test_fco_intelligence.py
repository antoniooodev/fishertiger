import json
from pathlib import Path

import pytest

from advisor.fco_intelligence import (
    FcoIntelligenceError,
    _audit_performance,
    _check_performance,
    _store_performance,
    _write,
    parse_cumulative,
    parse_lineups,
    parse_ownership,
    parse_performance,
    parse_prices,
)

SEASON = "2026/27"


def vote_table(caption, name, state="", votes=("6,5", "s.v.", "–"), bonus=""):
    return f"""
    <table><caption>{caption}</caption><thead><tr><th>Player</th><th>FC</th><th>ROM</th><th>TOR</th></tr></thead>
    <tbody><tr><th><span class='prb-nome'>{name}<small>A</small></span><span class='prb-tabellino'>
    {state}{bonus}</span></th>{''.join(f'<td>{vote}</td>' for vote in votes)}</tr></tbody></table>"""


@pytest.fixture
def performance_html():
    panes = []
    for index in range(10):
        status = "Terminata"
        header = f"""<header class='prb-incontro'><a class='prb-incontro__nome'>Home{index}</a>
        <p class='prb-incontro__punteggio'>2:1</p><p class='prb-incontro__stato'>{status}</p>
        <p class='prb-incontro__data'>{index + 1:02}/09/2026 20:45</p><a class='prb-incontro__nome'>Away{index}</a></header>"""
        home = vote_table("Scesi in campo: voto di ogni redazione", f"Starter{index}", "<span title='Sostituito dopo 61 minuti'></span>", ("6,5", "6", "6"), "<span title='1 Goal Segnato su Azione'></span><span title='Ammonizione'></span>")
        home += vote_table("In panchina: voto di ogni redazione", f"Sub{index}", "<span title='Entrato dalla panchina — 29 minuti giocati'></span>", ("s.v.", "6", "6"), "<span title='1 Assist Intenzionale su Azione'></span>")
        away = vote_table("Scesi in campo: voto di ogni redazione", f"Other{index}", votes=("6", "6", "6"), bonus="<span title='1 Goal Subito'></span><span title='Espulsione'></span>")
        away += vote_table("In panchina: voto di ogni redazione", f"Unused{index}", "<span title='Non è mai entrato in campo'></span>")
        panes.append(f"<div class='tab-pane'>{header}<section class='prb-squadra'><h2 class='prb-squadra__nome'>Home{index}</h2>{home}</section><section class='prb-squadra'><h2 class='prb-squadra__nome'>Away{index}</h2>{away}</section></div>")
    return "<html><head><title>Voti Fantacalcio Serie A 2026/2027 - 3ª Giornata</title></head><body><h1>Voti della 3ª giornata</h1>" + "".join(panes) + "</body></html>"


def test_performance_votes_context_events_and_provisional(performance_html):
    parsed = parse_performance(performance_html, SEASON, 3)
    starter, substitute, unused = parsed["records"][0], parsed["records"][1], parsed["records"][3]
    assert len(parsed["fixtures"]) == 10 and parsed["state"] == "final"
    assert starter["started"] and starter["substitution_minute"] == 61 and starter["goals"] == 1 and starter["yellow_cards"] == 1
    assert starter["vote_fc"] == {"state": "numeric", "value": 6.5}
    assert substitute["entered_from_bench"] and substitute["entry_minute"] is None and substitute["minutes_played"] == 29 and substitute["assists"] == 1
    assert substitute["vote_fc"]["state"] == "sv" and unused["did_not_enter"] and unused["vote_torino"]["state"] == "unpublished"
    assert starter["penalties_scored"] is None
    unfinished = performance_html.replace("Terminata", "Non iniziata", 1)
    assert parse_performance(unfinished, SEASON, 3)["state"] == "provisional"
    postponed = performance_html.replace("Terminata", "Rinviata", 1)
    assert parse_performance(postponed, SEASON, 3)["state"] == "provisional"


def ownership_html(*, cohort="", pct="17,2%", delta="-2,9"):
    dataset = {"@type": "Dataset", "name": "I giocatori più comprati all'asta di fantacalcio 2026/2027", "dateModified": "2026-09-18", "measurementTechnique": "contando solo le squadre con più di 10 giocatori"}
    return f"""<script type='application/ld+json'>{json.dumps(dataset)}</script><h1>Asta fantacalcio 2026/2027: i giocatori più comprati</h1><p>Dati rifatti ogni notte. Da 30 squadre in su.</p>
    <form><select name='ruoli'><option value='fcit' selected>FCIT</option></select>
    <select name='leghe'><option value='{cohort}' selected>Cohort</option></select></form>
    <p class='fco-tagli__intro'>L'elenco del giorno, aggiornato al 18/09/2026: 1 calciatori quotati</p>
    <table id='piu_comprati'><thead><tr>{''.join(f'<th>{h}</th>' for h in ['Ruolo','Squadra','Nome','Kap.','Comprato da','Prezzo 350','Prezzo 500','Titolare','7 gg'])}</tr></thead>
    <tbody><tr><td>A</td><td>Roma</td><td>MALEN Donyell</td><td>62</td><td>{pct}</td><td>71</td><td>100</td><td></td><td>{delta}</td></tr></tbody></table>"""


@pytest.mark.parametrize("cohort,raw", [("overall", ""), ("lte9", "piccole"), ("gte10", "grandi")])
def test_ownership_contract_and_cohorts(cohort, raw):
    row = parse_ownership(ownership_html(cohort=raw), SEASON, cohort)["rows"][0]
    assert row["ownership_pct"] == 17.2 and row["ownership_delta_7d"] == -2.9
    assert parse_ownership(ownership_html(cohort=raw, pct="", delta="+1,5"), SEASON, cohort)["rows"][0]["ownership_pct"] is None
    with pytest.raises(FcoIntelligenceError, match="Malformed percentage"):
        parse_ownership(ownership_html(cohort=raw, pct="maybe"), SEASON, cohort)


def price_html(badge="", prices=("71.62", "72", "95", "99")):
    dataset = {"@type": "Dataset", "name": "Prezzi medi d'asta del fantacalcio 2025/2026", "dateModified": "2026-09-18", "measurementTechnique": "soglia minima di 3 aste per calciatore", "size": {"value": 1}}
    name = f"<span class='text-bold'>MALEN</span><span class='text-muted'>Donyell</span>{badge}"
    headers = ['Ruolo','Squadra','Nome','Kap.','8 sq. / 350','10 sq. / 350','8 sq. / 500','10 sq. / 500','M.V.','Pres.']
    return f"""<script type='application/ld+json'>{json.dumps(dataset)}</script><table id='players_list'><thead><tr>{''.join(f'<th>{h}</th>' for h in headers)}</tr></thead><tbody><tr><td>A</td><td>Roma</td><td>{name}</td><td>62</td>{''.join(f'<td>{x}</td>' for x in prices)}<td>6,2</td><td>30</td></tr></tbody></table>"""


def test_prices_current_fallback_new_blank_and_four_cohorts():
    current = parse_prices(price_html(), SEASON)["rows"][0]
    assert [current[field]["value"] for field in ("price_8_350", "price_10_350", "price_8_500", "price_10_500")] == [71.62, 72.0, 95.0, 99.0]
    assert current["price_8_350"]["current_season"]
    old = parse_prices(price_html("<span class='fco-etichetta'>2025/2026</span>"), SEASON)["rows"][0]
    assert old["price_8_350"]["fallback_previous_season"] and old["price_8_350"]["price_season"] == "2025/26"
    new = parse_prices(price_html("<span class='fco-etichetta'>Nuovo</span>", ("", "", "", "")), SEASON)["rows"][0]
    assert new["new_player"] and new["price_10_500"]["unavailable"]
    with pytest.raises(FcoIntelligenceError, match="three-auction"):
        parse_prices(price_html().replace("soglia minima di 3 aste", "soglia minima di 10 aste"), SEASON)


def lineup_table(caption, name, values=("60%", "90%", "–", "90%", "69%"), official=False):
    headers = ["Titolare", "Fc", "Gaz", "SOS", "Sky", "Media*", "Uff."]
    return f"<table><caption>{caption}</caption><thead><tr>{''.join(f'<th>{x}</th>' for x in headers)}</tr></thead><tbody><tr><th><span class='prb-nome'>{name}<small>A</small></span></th>{''.join(f'<td>{x}</td>' for x in values)}<td>{'<span>confermato</span>' if official else ''}</td></tr></tbody></table>"


@pytest.fixture
def lineups_html():
    panes = []
    for index in range(10):
        header = f"<header class='prb-incontro'><a class='prb-incontro__nome'>Home{index}</a><p class='prb-incontro__punteggio'></p><p class='prb-incontro__stato'>Non iniziata</p><p class='prb-incontro__data'>2{index}/09/2026 20:45</p><a class='prb-incontro__nome'>Away{index}</a></header>"
        sections = []
        for side in ("Home", "Away"):
            team = f"{side}{index}"
            tables = lineup_table("Probabili titolari: percentuale di schierabilita' per redazione", f"Starter{side}{index}", official=index == 0 and side == "Home")
            tables += lineup_table("Probabile panchina: percentuale di schierabilita' per redazione", f"Bench{side}{index}", ("10%", "20%", "30%", "40%", "21%"))
            unavailable = f"<div class='prb-fuori'><p class='prb-fuori__titolo'>Indisponibili</p><ul><li class='prb-fuori__riga'><span class='prb-nome'>Out{side}{index}<small>A</small></span></li></ul></div>"
            sections.append(f"<section class='prb-squadra'><h2 class='prb-squadra__nome'>{team}</h2>{tables}{unavailable}</section>")
        panes.append(f"<div class='tab-pane'>{header}{''.join(sections)}</div>")
    dataset = {"@type": "Dataset", "name": "Probabili formazioni 5ª giornata di Serie A 2026/2027", "dateModified": "2026-09-18T18:00:00+02:00"}
    return f"<script type='application/ld+json'>{json.dumps(dataset)}</script><p>Ultima rilevazione: 18 settembre 2026 alle 18:00. Per questa giornata hanno pubblicato <b>4 redazioni su 4</b> per un totale di <b>60 calciatori</b> valutati.</p>{''.join(panes)}"


def test_lineups_sources_weighted_sections_and_official(lineups_html):
    parsed = parse_lineups(lineups_html, SEASON, 5)
    starter, bench, unavailable = parsed["rows"][:3]
    assert len(parsed["fixtures"]) == 10 and len(parsed["rows"]) == 60
    assert starter["section"] == "probable_starter" and starter["weighted_pct"] == 69 and starter["sos_pct"] is None and starter["source_count"] == 3 and starter["official_confirmed"]
    assert bench["section"] == "probable_bench" and unavailable["section"] == "unavailable" and unavailable["weighted_pct"] is None
    fewer = lineups_html.replace("4 redazioni su 4", "3 redazioni su 4", 1)
    assert parse_lineups(fewer, SEASON, 5)["active_source_count"] == 3
    changed = lineups_html.replace("2026-09-18T18:00:00+02:00", "2026-09-18T19:00:00+02:00")
    assert parse_lineups(changed, SEASON, 5)["observation_at"].endswith("19:00:00+02:00")


def cumulative_html(assists=2):
    headers = ["RT", "Squadra", "Nome", "Kap.", "PR", "MV5", "FM5", "", "GR+", "GR-", "RG+", "A+", "AF+", "PD+", "P/T", "EG-", "ET-", "RC-"]
    values = ["A", "Roma", "Malen", "62", "", "", "", "", "0", "0", "0", str(assists), "0", "0", "0", "0", "0", "0"]
    return f"<p class='fco-occhiello'>Serie A 2026/2027</p><table><thead><tr>{''.join(f'<th>{x}</th>' for x in headers)}</tr></thead><tbody><tr>{''.join(f'<td>{x}</td>' for x in values)}</tr></tbody></table>"


def test_cumulative_cross_check_discrepancy(tmp_path):
    rows = parse_cumulative(cumulative_html(), SEASON)
    players = [{"Id": 1, "Nome": "Malen", "Squadra": "Roma", "R": "A"}]
    directory = tmp_path / "performance-v1"
    snapshot = {"event_availability": {"assists": True}, "players": [{"fantacalcio_id": 1, "assists": 1}]}
    path = directory / "matchdays" / "01.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(snapshot))
    audit = _audit_performance(directory, rows, players)
    assert audit["discrepancies"] == [{"fantacalcio_id": 1, "metric": "assists", "matchdays": 1, "cumulative": 2}]


def test_unresolved_identity_and_final_revision_are_traceable(tmp_path, performance_html):
    class Profile:
        profile_id = "test"
        class season:
            season = SEASON
    parsed = parse_performance(performance_html, SEASON, 3)
    first = _store_performance(tmp_path, Profile(), parsed, 3, "2026-09-18T10:00:00+00:00", [])
    assert first["unresolved"] and first["validation"]["resolved"] == 0
    revised = parse_performance(performance_html.replace("6,5", "7,0", 1), SEASON, 3)
    second = _store_performance(tmp_path, Profile(), revised, 3, "2026-09-18T11:00:00+00:00", [])
    assert len(second["revisions"]) == 1
    assert list((tmp_path / "test/2026-27/performance-v1/revisions/03").glob("*.json"))


def test_daily_market_history_is_immutable_and_not_duplicated(tmp_path):
    path = tmp_path / "history/2026-09-18.json"
    _write(path, {"source_date": "2026-09-18", "players": []}, immutable=True)
    _write(path, {"source_date": "2026-09-18", "players": []}, immutable=True)
    assert [item.name for item in path.parent.iterdir()] == ["2026-09-18.json"]
    with pytest.raises(FcoIntelligenceError, match="Immutable"):
        _write(path, {"source_date": "2026-09-18", "players": [1]}, immutable=True)


def test_finalized_rounds_are_not_refetched_during_normal_updates(tmp_path, performance_html):
    class Profile:
        profile_id = "test"
        class season:
            season = SEASON
    profile = Profile()
    for matchday in range(1, 4):
        html = performance_html.replace("3ª Giornata", f"{matchday}ª Giornata").replace("3ª giornata", f"{matchday}ª giornata")
        _store_performance(tmp_path, profile, parse_performance(html, SEASON, matchday), matchday, "2026-09-18T10:00:00+00:00", [])
    calls = []
    def fetcher(url):
        calls.append(url)
        return performance_html if "voti/ultima-giornata" in url else cumulative_html()
    result = _check_performance(tmp_path, profile, fetcher, [], "2026-09-18T11:00:00+00:00", False)
    assert result["final_matchdays"] == 3
    assert len(calls) == 2 and not any("voti/1-giornata" in url or "voti/2-giornata" in url or "voti/3-giornata" in url for url in calls)
