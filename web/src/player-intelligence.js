import { projectedContribution } from "./player-valuation.js";

const id = (value) => String(value ?? "");
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const percentile = (values, value) => Number.isFinite(value) && values.length ? Math.round(values.filter((item) => item <= value).length / values.length * 100) : null;

export const finalizedForm = (performance, playerId) => {
  const states = new Map((performance?.matchdays || []).map((row) => [row.matchday, row.state]));
  const rows = (performance?.players || []).filter((row) => id(row.fantacalcio_id) === id(playerId) && states.get(row.matchday) === "final");
  const appearances = rows.filter((row) => row.started || row.entered_from_bench);
  const votes = rows.filter((row) => row.vote_fc?.state === "numeric").map((row) => Number(row.vote_fc.value));
  return {
    final_appearances: appearances.length,
    starts: appearances.filter((row) => row.started).length,
    substitute_appearances: appearances.filter((row) => row.entered_from_bench).length,
    minutes: appearances.reduce((sum, row) => sum + (Number.isFinite(row.minutes_played) ? row.minutes_played : 0), 0),
    numeric_fc_votes: votes.length,
    mean_fc_vote: mean(votes),
    last_3_mean: mean(votes.slice(-3)), last_3_sample_size: votes.slice(-3).length,
    last_5_mean: mean(votes.slice(-5)), last_5_sample_size: votes.slice(-5).length,
    ...Object.fromEntries(["goals", "assists", "yellow_cards", "red_cards"].map((key) => [key, rows.reduce((sum, row) => sum + (Number.isFinite(row[key]) ? row[key] : 0), 0)])),
  };
};

export const p1PlayerViewModel = (snapshot, playerId, players = [], rules = {}) => {
  const states = new Map((snapshot?.performance?.matchdays || []).map((row) => [row.matchday, row.state]));
  const performance = (snapshot?.performance?.players || [])
    .filter((row) => id(row.fantacalcio_id) === id(playerId))
    .map((row) => ({ ...row, round_state: states.get(row.matchday) || "provisional" }))
    .sort((left, right) => right.matchday - left.matchday);
  const marketRows = snapshot?.market?.players || [];
  const market = marketRows.find((row) => id(row.fantacalcio_id) === id(playerId)) || null;
  const forecast = (snapshot?.forecast?.players || []).find((row) => id(row.fantacalcio_id) === id(playerId)) || null;
  const lineup = (snapshot?.lineups?.players || []).find((row) => id(row.fantacalcio_id) === id(playerId) && row.matchday === snapshot?.lineups?.matchday && row.fixture_state === "upcoming") || null;
  const player = players.find((row) => id(row.id) === id(playerId));
  const role = player?.ruolo || market?.canonical_role;
  const modelValues = players.filter((row) => row.ruolo === role).map((row) => projectedContribution(row, rules?.horizons?.currentLeague?.matchdayIndices)).filter(Number.isFinite);
  const modelValue = player ? projectedContribution(player, rules?.horizons?.currentLeague?.matchdayIndices) : null;
  const priceFor = (row) => row?.price_cohort_compatible ? row.market_price : row?.benchmark_market_price;
  const currentPrices = marketRows.filter((row) => row.canonical_role === role).map(priceFor).filter((price) => price?.current_season && !price?.fallback_previous_season && !price?.unavailable && Number.isFinite(price?.value)).map((price) => price.value);
  const selectedPrice = priceFor(market);
  const ownershipValues = marketRows.filter((row) => row.canonical_role === role && Number.isFinite(row.ownership_pct)).map((row) => row.ownership_pct);
  const modelPercentile = percentile(modelValues, modelValue);
  const marketPercentile = selectedPrice?.current_season && !selectedPrice?.fallback_previous_season && !selectedPrice?.unavailable ? percentile(currentPrices, selectedPrice.value) : null;
  return {
    performance: performance.slice(0, 5),
    form: (snapshot?.performance?.form_analytics || []).find((row) => id(row.fantacalcio_id) === id(playerId)) || finalizedForm(snapshot?.performance, playerId),
    market,
    forecast: forecast && { ...forecast, potential_gap: forecast.fantaindex_potential - forecast.fantaindex_current },
    lineup,
    positioning: { model_percentile: modelPercentile, market_percentile: marketPercentile, model_market_gap_pp: Number.isFinite(modelPercentile) && Number.isFinite(marketPercentile) ? modelPercentile - marketPercentile : null, ownership_role_percentile: Number.isFinite(market?.ownership_pct) ? percentile(ownershipValues, market.ownership_pct) : null, market_sample_size: currentPrices.length, model_sample_size: modelValues.length, ownership_sample_size: ownershipValues.length, non_comparable_credits: market ? !market.price_cohort_compatible : null },
  };
};

export const voteLabel = (vote) => vote?.state === "numeric" ? Number(vote.value).toFixed(1) : vote?.state === "sv" ? "s.v." : "—";

export const appearanceLabel = (row) => {
  if (row?.did_not_enter) return "non entrato";
  if (Number.isFinite(row?.minutes_played)) return `${row.minutes_played}'`;
  return row?.entered_from_bench ? "subentrato" : row?.started ? "titolare" : "—";
};
