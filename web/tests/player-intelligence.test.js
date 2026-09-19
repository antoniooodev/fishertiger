import test from "node:test";
import assert from "node:assert/strict";
import { appearanceLabel, finalizedForm, p1PlayerViewModel, voteLabel } from "../src/player-intelligence.js";
import { createRoleValuation } from "../src/player-valuation.js";

const status = {
  performance: { matchdays: [{ matchday: 1, state: "final" }, { matchday: 2, state: "final" }, { matchday: 3, state: "final" }, { matchday: 4, state: "provisional" }], players: [
    { fantacalcio_id: 1, matchday: 3, venue: "HOME", opponent: "Milan", started: true, minutes_played: 90, vote_fc: { state: "numeric", value: 6.5 }, goals: 1, assists: 0, yellow_cards: 0, red_cards: 0 },
    { fantacalcio_id: 1, matchday: 2, venue: "AWAY", opponent: "Roma", entered_from_bench: true, minutes_played: 8, vote_fc: { state: "sv", value: null }, goals: null, assists: null, yellow_cards: null, red_cards: null },
    { fantacalcio_id: 1, matchday: 1, did_not_enter: true, vote_fc: { state: "unpublished", value: null } },
    { fantacalcio_id: 1, matchday: 4, started: true, minutes_played: 90, vote_fc: { state: "numeric", value: 10 }, goals: 5 },
  ] },
  market: { players: [
    { fantacalcio_id: 1, canonical_role: "A", ownership_pct: 17.2, ownership_delta_7d: -2.9, price_cohort_compatible: false, active_league: { participants: 8, credits: 750 }, market_source_date: "2026-09-18", price_source_date: "2026-09-17", benchmark_market_price_cohort: { teams: 8, credits: 500 }, benchmark_market_price: { value: 71.62, current_season: true, price_season: "2026/27" } },
    { fantacalcio_id: 2, canonical_role: "A", ownership_pct: 30, price_cohort_compatible: false, benchmark_market_price: { value: 100, current_season: true } },
    { fantacalcio_id: 3, canonical_role: "A", ownership_pct: 5, price_cohort_compatible: false, benchmark_market_price: { value: 1, fallback_previous_season: true } },
    { fantacalcio_id: 4, canonical_role: "A", ownership_pct: null, price_cohort_compatible: false, benchmark_market_price: { value: null, unavailable: true } },
  ] },
  forecast: { players: [{ fantacalcio_id: 1, fantaindex_current: 6.6, fantaindex_potential: 7.5, season_availability_pct: 70, source_date: "2026-09-19" }] },
  lineups: { matchday: 4, players: [{ fantacalcio_id: 1, matchday: 4, fixture_state: "upcoming", weighted_pct: 69, fc_pct: 60, gaz_pct: 90, sos_pct: null, sky_pct: 90, source_count: 3 }] },
};

test("builds current performance, market cohort and next-matchday source detail", () => {
  const players = [
    { id: 1, ruolo: "A", proiezione: { p_gioca: .8, voto_puro: 6, bonus: 0 } },
    { id: 2, ruolo: "A", proiezione: { p_gioca: .5, voto_puro: 6, bonus: 0 } },
    { id: 3, ruolo: "A", proiezione: { p_gioca: .8, voto_puro: 6, bonus: 0 } },
  ];
  const view = p1PlayerViewModel(status, 1, players, {});
  assert.equal(view.form.mean_fc_vote, 6.5);
  assert.equal(view.form.goals, 1);
  assert.equal(view.market.benchmark_market_price_cohort.teams, 8);
  assert.equal(view.positioning.non_comparable_credits, true);
  assert.equal(view.positioning.market_sample_size, 2);
  assert.equal(view.positioning.model_percentile, 100);
  assert.equal(view.positioning.market_percentile, 50);
  assert.equal(view.positioning.model_market_gap_pp, 50);
  assert.equal(view.positioning.ownership_role_percentile, 67);
  assert.equal(p1PlayerViewModel(status, 3, players, {}).positioning.model_percentile, 100);
  assert.equal(view.forecast.season_availability_pct, 70);
  assert.ok(Math.abs(view.forecast.potential_gap - .9) < 1e-9);
  assert.equal(view.market.market_source_date, "2026-09-18");
  assert.equal(view.market.price_source_date, "2026-09-17");
  assert.equal(view.lineup.weighted_pct, 69);
  assert.equal(view.lineup.sos_pct, null);
});

test("final form excludes provisional votes, s.v. and did-not-play rows", () => {
  const form = finalizedForm(status.performance, 1);
  assert.equal(form.numeric_fc_votes, 1);
  assert.equal(form.mean_fc_vote, 6.5);
  assert.equal(form.final_appearances, 2);
  assert.equal(form.last_3_sample_size, 1);
  assert.equal(form.last_5_sample_size, 1);
});

test("does not expose a stale previous-round lineup for an empty upcoming round", () => {
  const stale = { ...status, lineups: { matchday: 5, active_source_count: 0, evaluated_players: 0, players: [{ ...status.lineups.players[0], matchday: 4 }] } };
  assert.equal(p1PlayerViewModel(stale, 1).lineup, null);
});

test("shows only the player whose fixture is still upcoming in a partially completed round", () => {
  const partial = { ...status, lineups: { matchday: 4, players: [
    { ...status.lineups.players[0], fantacalcio_id: 1, fixture_state: "completed" },
    { ...status.lineups.players[0], fantacalcio_id: 2, fixture_state: "upcoming" },
  ] } };
  assert.equal(p1PlayerViewModel(partial, 1).lineup, null);
  assert.equal(p1PlayerViewModel(partial, 2).lineup.weighted_pct, 69);
});

test("keeps s.v., unpublished and absence distinct", () => {
  assert.equal(voteLabel(status.performance.players[0].vote_fc), "6.5");
  assert.equal(voteLabel(status.performance.players[1].vote_fc), "s.v.");
  assert.equal(voteLabel(status.performance.players[2].vote_fc), "—");
  assert.equal(appearanceLabel(status.performance.players[2]), "non entrato");
});

test("P1 fields do not alter valuation", () => {
  const rules = { participants: 8, rosterSlots: { A: 1 }, startingCredits: 500, auction: { roleBudgetPercentages: { A: 50 } }, horizons: { currentLeague: { matchdayIndices: [0] } } };
  const player = { id: 1, ruolo: "A", fvm_original: 50, proiezione: { p_gioca: .8, voto_puro: 6, bonus: .5 } };
  const baseline = createRoleValuation([player], rules).normalizedFvm(player);
  const enriched = { ...player, p1: status };
  assert.equal(createRoleValuation([enriched], rules).normalizedFvm(enriched), baseline);
});
