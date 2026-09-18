import test from "node:test";
import assert from "node:assert/strict";
import {
  effectiveAvailability,
  enrichPlayersWithAvailability,
  normalizeInjuryStatus,
} from "../src/injury-state.js";
import { FORCE_AVAILABLE, FORCE_OUT } from "../src/player-injuries.js";

const automatic = { fantacalcio_id: 7, availability: "QUESTIONABLE", reason: "Knock" };

test("automatic state normalization keeps only valid resolved availability", () => {
  const status = normalizeInjuryStatus({
    state: "fresh",
    configured: true,
    cache_age_seconds: 10,
    snapshot: { players: [automatic, { fantacalcio_id: 8, availability: "SUSPENDED" }], unresolved: [{ provider_player_id: 9 }] },
  });
  assert.equal(status.snapshot.players.length, 1);
  assert.equal(status.snapshot.unresolved.length, 1);
});

test("automatic state applies with no override", () => {
  assert.equal(effectiveAvailability(automatic, null).effective, "QUESTIONABLE");
});

test("manual overrides force unavailable or suppress automatic availability", () => {
  assert.equal(effectiveAvailability(automatic, FORCE_OUT).effective, "OUT");
  assert.equal(effectiveAvailability(automatic, FORCE_AVAILABLE).effective, null);
});

test("enrichment is immutable and never creates confirmed_inactive", () => {
  const original = { id: 7, nome: "Player" };
  const [enriched] = enrichPlayersWithAvailability(
    [original],
    { snapshot: { players: [automatic] } },
    {},
  );
  assert.notEqual(enriched, original);
  assert.equal(enriched.availability_overlay.effective, "QUESTIONABLE");
  assert.equal("availability_overlay" in original, false);
  assert.equal("confirmed_inactive" in enriched, false);
});
