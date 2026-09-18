import { useEffect, useMemo, useRef, useState } from "react";
import { checkInjuries, getInjuryStatus } from "./updates-client.js";
import {
  FORCE_AVAILABLE,
  FORCE_OUT,
  loadPlayerInjuries,
  savePlayerInjuries,
  withPlayerInjury,
} from "./player-injuries.js";

const automaticRefreshes = new Set();
const inFlightRefreshes = new Map();

const sharedCheck = (profile, apiBase, key) => {
  if (!inFlightRefreshes.has(key)) {
    const request = checkInjuries(profile, { apiBase })
      .finally(() => inFlightRefreshes.delete(key));
    inFlightRefreshes.set(key, request);
  }
  return inFlightRefreshes.get(key);
};

export const normalizeInjuryStatus = (raw) => {
  const snapshot = raw?.snapshot && typeof raw.snapshot === "object" ? raw.snapshot : null;
  const players = Array.isArray(snapshot?.players)
    ? snapshot.players.filter(
      (item) => Number.isInteger(item?.fantacalcio_id) && ["OUT", "QUESTIONABLE"].includes(item?.availability),
    )
    : [];
  const unresolved = Array.isArray(snapshot?.unresolved) ? snapshot.unresolved : [];
  return {
    state: ["unconfigured", "never_checked", "fresh", "stale", "unsupported", "error"].includes(raw?.state)
      ? raw.state
      : "error",
    configured: raw?.configured === true,
    fresh: raw?.fresh === true,
    cacheAgeSeconds: Number.isFinite(raw?.cache_age_seconds) ? Math.max(0, raw.cache_age_seconds) : null,
    ttlSeconds: Number.isFinite(raw?.ttl_seconds) ? raw.ttl_seconds : 14400,
    warning: typeof raw?.warning === "string" ? raw.warning : "",
    snapshot: snapshot ? { ...snapshot, players, unresolved } : null,
  };
};

export const effectiveAvailability = (automatic, override) => {
  const normalizedOverride = [FORCE_OUT, FORCE_AVAILABLE].includes(override) ? override : null;
  return {
    automatic: automatic || null,
    override: normalizedOverride,
    effective: normalizedOverride === FORCE_OUT
      ? "OUT"
      : normalizedOverride === FORCE_AVAILABLE
        ? null
        : automatic?.availability || null,
    source: normalizedOverride ? "manual" : automatic ? "api-football" : null,
  };
};

export const enrichPlayersWithAvailability = (players, status, overrides) => {
  const automatic = new Map(
    (status?.snapshot?.players || []).map((item) => [String(item.fantacalcio_id), item]),
  );
  return (players || []).map((player) => ({
    ...player,
    availability_overlay: {
      ...effectiveAvailability(
        automatic.get(String(player.id)),
        overrides?.[String(player.id)],
      ),
      checkedAt: status?.snapshot?.checked_at || null,
    },
  }));
};

export const injuryUpdateViewModel = (status) => {
  const players = status?.snapshot?.players || [];
  return {
    out: players.filter((player) => player.availability === "OUT"),
    questionable: players.filter((player) => player.availability === "QUESTIONABLE"),
    unresolved: status?.snapshot?.unresolved || [],
    unconfiguredMessage: status?.configured === false
      ? "API_FOOTBALL_KEY non configurata nel backend."
      : "",
    warningMessage: status?.warning
      ? `${status.snapshot ? `${status.fresh ? "Cache" : "Cache scaduta"} conservata. ` : ""}${status.warning}`
      : "",
  };
};

export const useInjuryState = ({ profile, apiBase, players }) => {
  const profileId = profile?.profile_id || "default";
  const season = profile?.season?.season || "";
  const [status, setStatus] = useState(() => normalizeInjuryStatus(null));
  const [overrides, setOverrides] = useState(() => loadPlayerInjuries(profileId));
  const [storageWarning, setStorageWarning] = useState("");
  const request = useRef(0);

  useEffect(() => {
    if (!profile) return undefined;
    let active = true;
    const token = ++request.current;
    const refreshKey = `${profileId}:${season}`;
    setOverrides(loadPlayerInjuries(profileId));
    setStorageWarning("");
    setStatus(normalizeInjuryStatus(null));
    getInjuryStatus(profile, { apiBase })
      .then(async (raw) => {
        if (!active || token !== request.current) return;
        const cached = normalizeInjuryStatus(raw);
        setStatus(cached);
        if (
          cached.configured
          && ["stale", "never_checked"].includes(cached.state)
          && !automaticRefreshes.has(refreshKey)
        ) {
          automaticRefreshes.add(refreshKey);
          try {
            const next = normalizeInjuryStatus(await sharedCheck(profile, apiBase, refreshKey));
            if (active && token === request.current) setStatus(next);
          } catch (error) {
            if (active && token === request.current)
              setStatus({ ...cached, state: "error", warning: error?.message || "Aggiornamento non riuscito." });
          }
        }
      })
      .catch((error) => {
        if (active && token === request.current)
          setStatus((current) => ({ ...current, state: "error", warning: error?.message || "Backend non raggiungibile." }));
      });
    return () => { active = false; };
  }, [apiBase, profileId, season]);

  const refresh = async () => {
    try {
      const next = normalizeInjuryStatus(await sharedCheck(profile, apiBase, `${profileId}:${season}`));
      setStatus(next);
      return next;
    } catch (error) {
      setStatus((current) => ({ ...current, state: "error", warning: error?.message || "Aggiornamento non riuscito." }));
      throw error;
    }
  };

  const setOverride = (playerId, value) => {
    const next = withPlayerInjury(overrides, playerId, value);
    setOverrides(next);
    setStorageWarning(savePlayerInjuries(profileId, next) ? "" : "Override non salvato: memoria browser non disponibile.");
  };

  return {
    status,
    overrides,
    storageWarning,
    refresh,
    setOverride,
    players: useMemo(
      () => enrichPlayersWithAvailability(players, status, overrides),
      [players, status, overrides],
    ),
  };
};
