import test from "node:test";
import assert from "node:assert/strict";
import { injuryUpdateViewModel } from "../src/injury-state.js";

test("cached update data keeps OUT, QUESTIONABLE and unresolved rows after failure", () => {
  const view = injuryUpdateViewModel({
    state: "error",
    configured: true,
    fresh: false,
    cacheAgeSeconds: 18000,
    warning: "Offline",
    snapshot: {
      checked_at: "2026-09-18T10:00:00+00:00",
      players: [
        { fantacalcio_id: 1, availability: "OUT" },
        { fantacalcio_id: 2, availability: "QUESTIONABLE" },
      ],
      unresolved: [{ provider_player_id: 3, provider_player_name: "Unknown", provider_team_name: "Roma", match_failure: "player_ambiguous" }],
    },
  });
  assert.equal(view.out.length, 1);
  assert.equal(view.questionable.length, 1);
  assert.equal(view.unresolved.length, 1);
  assert.equal(view.warningMessage, "Cache scaduta conservata. Offline");
});

test("the unconfigured view names the backend variable and keeps browser input out", () => {
  const view = injuryUpdateViewModel({ configured: false, warning: "", snapshot: null });
  assert.equal(view.unconfiguredMessage, "API_FOOTBALL_KEY non configurata nel backend.");
  assert.doesNotMatch(view.unconfiguredMessage, /incolla|password/i);
});
