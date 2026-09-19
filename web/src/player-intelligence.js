const id = (value) => String(value ?? "");

export const p1PlayerViewModel = (snapshot, playerId) => {
  const performance = (snapshot?.performance?.players || [])
    .filter((row) => id(row.fantacalcio_id) === id(playerId))
    .sort((left, right) => right.matchday - left.matchday);
  const numeric = performance
    .map((row) => row.vote_fc?.state === "numeric" ? row.vote_fc.value : null)
    .filter(Number.isFinite);
  const market = (snapshot?.market?.players || []).find((row) => id(row.fantacalcio_id) === id(playerId)) || null;
  const lineup = (snapshot?.lineups?.players || []).find((row) => id(row.fantacalcio_id) === id(playerId) && row.matchday === snapshot?.lineups?.matchday && row.fixture_state === "upcoming") || null;
  return {
    performance: performance.slice(0, 5),
    averageFc: numeric.length ? numeric.reduce((sum, value) => sum + value, 0) / numeric.length : null,
    totals: Object.fromEntries(["goals", "assists", "yellow_cards", "red_cards"].map((key) => {
      const values = performance.map((row) => row[key]).filter(Number.isFinite);
      return [key, values.length ? values.reduce((sum, value) => sum + value, 0) : null];
    })),
    market,
    lineup,
  };
};

export const voteLabel = (vote) => vote?.state === "numeric"
  ? Number(vote.value).toFixed(1)
  : vote?.state === "sv" ? "s.v." : "—";

export const appearanceLabel = (row) => {
  if (row?.did_not_enter) return "non entrato";
  if (Number.isFinite(row?.minutes_played)) return `${row.minutes_played}'`;
  return row?.entered_from_bench ? "subentrato" : row?.started ? "titolare" : "—";
};
