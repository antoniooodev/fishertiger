import { useEffect, useMemo, useRef, useState } from "react";
import { ImageIcon, Radio, Star, StickyNote } from "lucide-react";
import { createRoleValuation, sourceFvm } from "../player-valuation.js";
import { normalizeRules } from "../league-rules.js";
import {
  assignPlayer,
  playerAuctionStatus,
  releasePlayer,
} from "../auction-store.js";
import { useAuctionBoard } from "../use-auction-store.js";
import { useAdvisor } from "../use-advisor.js";
import { reconcileSelectedPlayer } from "../player-selection.js";
import {
  AdviceDetail,
  BidGauge,
  PriceStepper,
  bidVerdict,
} from "../auction-advice.jsx";
import { loadPlayerFilters, savePlayerFilters } from "../player-filters.js";
import {
  loadPlayerNotes,
  playerMark,
  savePlayerNotes,
  targetCount,
  withNote,
  withTarget,
} from "../player-notes.js";
import {
  playerImageUrl,
  readMediaPreference,
  teamLogoUrl,
  writeMediaPreference,
} from "../player-media.js";
import { getFcoStatus } from "../updates-client.js";
import { appearanceLabel, p1PlayerViewModel, voteLabel } from "../player-intelligence.js";
import {
  Empty,
  PlayerRow,
  RoleChip,
  ROLE_LABELS,
  Segmented,
  Sheet,
  formatTier,
  useMediaQuery,
} from "../ui.jsx";

const PAGE = 60;

const ROLE_OPTIONS = [
  { value: "TUTTI", label: "Tutti" },
  ...Object.keys(ROLE_LABELS).map((role) => ({ value: role, label: role })),
];

const ROLE_VALUES = ROLE_OPTIONS.map((option) => option.value);

const HISTORY_COLUMNS = [
  ["Pv", "PV"],
  ["Mv", "MV"],
  ["Fm", "FM"],
  ["Gf", "G"],
  ["Ass", "A"],
  ["Amm", "AMM"],
];

const NOTE_MAX_LENGTH = 1000;

function PlayerAvatar({ player, size = "small" }) {
  const [failed, setFailed] = useState(false);
  const url = playerImageUrl(player, size);
  useEffect(() => setFailed(false), [url]);
  if (!url || failed) return null;
  const box = size === "small" ? 32 : 72;
  return (
    <img
      className={`player-avatar${size === "small" ? "" : " player-avatar--lg"}`}
      src={url}
      alt=""
      width={box}
      height={box}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function TeamLogo({ team }) {
  const [failed, setFailed] = useState(false);
  const url = teamLogoUrl(team);
  useEffect(() => setFailed(false), [url]);
  if (!url || failed) return null;
  return (
    <img
      className="team-logo"
      src={url}
      alt=""
      width={28}
      height={28}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

export default function PlayersView({
  data,
  rules,
  profileId,
  selected,
  setSelected,
  initialRole,
  profile,
  apiBase = "",
}) {
  const teamValues = useMemo(
    () => ["TUTTE", ...data.teams.map((item) => item.squadra)],
    [data.teams],
  );
  const rulesSignature = JSON.stringify(rules ?? data.league_rules ?? null);
  const activeRules = useMemo(
    () =>
      normalizeRules(rules ?? data.league_rules ?? { startingCredits: 750 }),
    [rulesSignature],
  );

  const [filters, setFilters] = useState(() =>
    loadPlayerFilters(profileId, ROLE_VALUES, teamValues),
  );
  const [notes, setNotes] = useState(() => loadPlayerNotes(profileId));
  const [notesWarning, setNotesWarning] = useState("");
  const [showMedia, setShowMedia] = useState(readMediaPreference);
  const [limit, setLimit] = useState(PAGE);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [assignOwner, setAssignOwner] = useState(0);
  const [assignPrice, setAssignPrice] = useState("");
  const [feedback, setFeedback] = useState(null);
  const [p1, setP1] = useState(null);
  const [priceFocusToken, setPriceFocusToken] = useState(0);
  const isDesktop = useMediaQuery("(min-width: 1000px)");
  const { query, role, team, onlyTargets, showLive } = filters;

  useEffect(() => {
    let active = true;
    setP1(null);
    if (profile) getFcoStatus(profile, { apiBase }).then((value) => active && setP1(value)).catch(() => {});
    return () => { active = false; };
  }, [apiBase, profile?.profile_id, profile?.season?.season]);

  useEffect(() => {
    setFilters(loadPlayerFilters(profileId, ROLE_VALUES, teamValues));
    setNotes(loadPlayerNotes(profileId));
    setNotesWarning("");
    setFeedback(null);
  }, [profileId]);

  const updateFilters = (patch) =>
    setFilters((current) => {
      const next = { ...current, ...patch };
      savePlayerFilters(profileId, next);
      return next;
    });

  const updateNotes = (next) => {
    setNotes(next);
    setNotesWarning(
      savePlayerNotes(profileId, next)
        ? ""
        : "Obiettivi e note non salvati: la memoria del browser non è disponibile.",
    );
  };

  const toggleMedia = () =>
    setShowMedia((current) => {
      writeMediaPreference(!current);
      return !current;
    });

  useEffect(() => {
    if (initialRole) updateFilters({ role: initialRole });
  }, [initialRole]);

  useEffect(() => {
    if (selected && !isDesktop) setSheetOpen(true);
  }, [selected, isDesktop]);

  const valuation = useMemo(
    () => createRoleValuation(data.players, activeRules),
    [data.players, activeRules],
  );

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.players
      .filter(
        (item) =>
          (role === "TUTTI" || item.ruolo === role) &&
          (team === "TUTTE" || item.squadra === team) &&
          (!onlyTargets || playerMark(notes, item.id).target) &&
          item.nome.toLowerCase().includes(needle),
      )
      .sort((a, b) => valuation.normalizedFvm(b) - valuation.normalizedFvm(a));
  }, [data.players, query, role, team, onlyTargets, notes, valuation]);

  useEffect(() => setLimit(PAGE), [query, role, team, onlyTargets]);

  const board = useAuctionBoard(profileId, data.players, activeRules, showLive);
  /* The panel drives assignment and notes, so every active filter must still
     admit an explicitly selected player. */
  const reconciledPlayer = reconcileSelectedPlayer(selected, rows);
  const player = selected ? reconciledPlayer : rows[0];
  const mark = player ? playerMark(notes, player.id) : null;
  const live = playerAuctionStatus(board, player);
  const targets = targetCount(notes);
  const { advice, failure: adviceFailure } = useAdvisor({
    player: live ? null : player,
    board,
    players: data.players,
    rules: activeRules,
  });

  useEffect(() => {
    if (board) setAssignOwner(board.userTeamIndex);
  }, [board?.userTeamIndex]);

  useEffect(() => {
    setAssignPrice("");
    setFeedback(null);
  }, [player?.id]);

  useEffect(() => {
    if (selected && !reconciledPlayer) setSelected(null);
  }, [selected, reconciledPlayer, setSelected]);

  const pick = (next) => {
    setSelected(next);
    if (!isDesktop) setSheetOpen(true);
  };

  const openAssign = (candidate) => {
    pick(candidate);
    setAssignPrice("");
    setFeedback(null);
    setPriceFocusToken((token) => token + 1);
  };

  const runAssign = () => {
    const result = assignPlayer(profileId, data.players, activeRules, {
      playerId: player.id,
      owner: assignOwner,
      price: Number(assignPrice),
    });
    setFeedback(result);
    if (result.ok) setAssignPrice("");
  };

  const runRelease = () =>
    setFeedback(
      releasePlayer(profileId, data.players, activeRules, player.id),
    );

  const detail = player ? (
    <PlayerDetail
      player={player}
      valuation={valuation}
      mark={mark}
      showMedia={showMedia}
      noteMaxLength={NOTE_MAX_LENGTH}
      intelligence={p1PlayerViewModel(p1, player.id)}
      onToggleTarget={() =>
        updateNotes(withTarget(notes, player.id, !mark.target))
      }
      onNoteChange={(value) => updateNotes(withNote(notes, player.id, value))}
      auction={
        board && {
          live,
          board,
          rules: activeRules,
          owner: assignOwner,
          setOwner: setAssignOwner,
          price: assignPrice,
          setPrice: setAssignPrice,
          feedback,
          focusToken: priceFocusToken,
          advice,
          adviceFailure,
          onAssign: runAssign,
          onRelease: runRelease,
        }
      }
    />
  ) : null;

  return (
    <>
      <div className="page-head">
        <span className="kicker">Listone</span>
        <h1>Profili, storico e proiezioni</h1>
      </div>

      <div className="filters">
        <div className="filters-row">
          <input
            className="input"
            value={query}
            onChange={(event) => updateFilters({ query: event.target.value })}
            placeholder="Cerca un giocatore"
            type="search"
            aria-label="Cerca un giocatore"
          />
          <select
            className="select"
            value={team}
            onChange={(event) => updateFilters({ team: event.target.value })}
            aria-label="Filtra per squadra"
            style={{ maxWidth: "9.5rem" }}
          >
            <option value="TUTTE">Tutte</option>
            {data.teams.map((item) => (
              <option key={item.squadra}>{item.squadra}</option>
            ))}
          </select>
        </div>
        <div className="filters-row">
          <Segmented
            options={ROLE_OPTIONS}
            value={role}
            onChange={(next) => updateFilters({ role: next })}
            label="Filtra per ruolo"
            roleColors
          />
          <span className="filters-count">{rows.length}</span>
        </div>
        <div className="chip-rail">
          <button
            type="button"
            className={`chip${onlyTargets ? " is-active" : ""}`}
            aria-pressed={onlyTargets}
            onClick={() => updateFilters({ onlyTargets: !onlyTargets })}
          >
            <Star
              size={13}
              fill={onlyTargets ? "currentColor" : "none"}
              aria-hidden="true"
            />
            Obiettivi
            <b>{targets}</b>
          </button>
          <button
            type="button"
            className={`chip${showLive ? " is-active" : ""}`}
            aria-pressed={showLive}
            onClick={() => updateFilters({ showLive: !showLive })}
            title="Mostra chi ha già preso ogni giocatore e assegna senza uscire da questa pagina"
          >
            <Radio size={13} aria-hidden="true" />
            Asta live
          </button>
          <button
            type="button"
            className={`chip${showMedia ? " is-active" : ""}`}
            aria-pressed={showMedia}
            onClick={toggleMedia}
            title="Carica campioncini e loghi da content.fantacalcio.it (circa 11 KB per giocatore, solo le righe visibili)"
          >
            <ImageIcon size={13} aria-hidden="true" />
            Immagini
          </button>
        </div>
      </div>

      {notesWarning ? (
        <p className="notice notice--stop" role="alert">
          {notesWarning}
        </p>
      ) : null}

      {showLive && board ? (
        <p className="live-legend">
          <span>
            <i className="k-mine" />
            Presi da te
          </span>
          <span>
            <i className="k-taken" />
            Presi dagli altri
          </span>
          <span className="live-legend-count">
            {board.taken
              ? `${board.taken} già assegnati`
              : "Nessuno ancora assegnato"}
            {board.activeRole
              ? ` · fase ${ROLE_LABELS[board.activeRole].toLowerCase()}`
              : ""}
          </span>
        </p>
      ) : null}

      <div className="players-split">
        <section className="card card--flush">
          {rows.length ? (
            <>
              <div className="list-head">
                <span>Giocatore</span>
                <span>{showLive ? "Valore · asta" : "Valore ruolo"}</span>
              </div>
              <div className="rows">
                {rows.slice(0, limit).map((item) => {
                  const itemMark = playerMark(notes, item.id);
                  const itemLive = playerAuctionStatus(board, item);
                  return (
                    <PlayerRow
                      key={item.id}
                      player={item}
                      className={`player-row${itemMark.target ? " is-target" : ""}${
                        itemLive
                          ? itemLive.mine
                            ? " is-live-mine"
                            : " is-live-taken"
                          : ""
                      }`}
                      selected={isDesktop && player?.id === item.id}
                      value={valuation.normalizedFvm(item).toFixed(1)}
                      onClick={() => pick(item)}
                      media={showMedia ? <PlayerAvatar player={item} /> : null}
                      crest={
                        showMedia ? <TeamLogo team={item.team_id} /> : null
                      }
                      flag={
                        itemMark.note ? (
                          <em className="note-flag" title={itemMark.note}>
                            <StickyNote size={11} aria-hidden="true" />
                          </em>
                        ) : null
                      }
                      lead={
                        <button
                          type="button"
                          className="row-star"
                          aria-pressed={itemMark.target}
                          aria-label={
                            itemMark.target
                              ? `Togli ${item.nome} dagli obiettivi`
                              : `Segna ${item.nome} come obiettivo`
                          }
                          onClick={() =>
                            updateNotes(
                              withTarget(notes, item.id, !itemMark.target),
                            )
                          }
                        >
                          <Star
                            size={15}
                            fill={itemMark.target ? "currentColor" : "none"}
                            aria-hidden="true"
                          />
                        </button>
                      }
                      trailing={
                        showLive ? (
                          itemLive ? (
                            <span className="live-cell">
                              <b title={itemLive.ownerName}>
                                {itemLive.mine ? "Tu" : itemLive.ownerName}
                              </b>
                              <small>{itemLive.price} cr</small>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="btn btn--sm live-assign-open"
                              onClick={() => openAssign(item)}
                              aria-label={`Assegna ${item.nome} a una squadra`}
                            >
                              Assegna
                            </button>
                          )
                        ) : null
                      }
                    />
                  );
                })}
              </div>
              {rows.length > limit ? (
                <div style={{ padding: "var(--s-3)" }}>
                  <button
                    type="button"
                    className="btn btn--block"
                    onClick={() => setLimit((value) => value + PAGE)}
                  >
                    Mostra altri {Math.min(PAGE, rows.length - limit)}
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <Empty title="Nessun giocatore trovato">
              {onlyTargets
                ? "Nessun obiettivo con questi filtri: togli «Obiettivi» o segna qualcuno con la stella."
                : "Prova a cambiare ruolo, squadra o testo cercato."}
            </Empty>
          )}
        </section>

        {isDesktop && detail ? (
          <aside className="player-detail-panel">
            <div className="card">{detail}</div>
          </aside>
        ) : null}
      </div>

      {!isDesktop ? (
        <Sheet
          open={sheetOpen && Boolean(detail)}
          onClose={() => setSheetOpen(false)}
          title="Scheda giocatore"
        >
          {detail}
        </Sheet>
      ) : null}
    </>
  );
}

export function PlayerDetail({
  player,
  valuation,
  mark,
  showMedia,
  noteMaxLength,
  auction,
  onToggleTarget,
  onNoteChange,
  intelligence,
}) {
  const history = Object.entries(player.storico || {});
  const outliers = valuation.outliersFor(player);
  const difference = player.quotazioni.differenza;

  return (
    <div className="stack">
      <div className="detail-head">
        {showMedia ? <PlayerAvatar player={player} size="medium" /> : null}
        <span className="detail-role">
          <RoleChip role={player.ruolo} large />
          {showMedia ? <TeamLogo team={player.team_id} /> : null}
        </span>
        <div className="detail-identity">
          <h2>{player.nome}</h2>
          <p>
            {player.squadra} · Mantra {player.ruoli_mantra || "n/d"}
          </p>
        </div>
        <span className="detail-actions">
          <span className="pill pill--brand">
            {formatTier(player.guida_asta_fascia)}
          </span>
          <button
            type="button"
            className={`icon-btn target-toggle${mark?.target ? " is-target" : ""}`}
            aria-pressed={Boolean(mark?.target)}
            aria-label={
              mark?.target
                ? `Togli ${player.nome} dagli obiettivi`
                : `Segna ${player.nome} come obiettivo`
            }
            onClick={onToggleTarget}
          >
            <Star
              size={16}
              fill={mark?.target ? "currentColor" : "none"}
              aria-hidden="true"
            />
          </button>
        </span>
      </div>

      {player.availability_overlay?.effective ? (
        <div className={`notice notice--${player.availability_overlay.effective === "OUT" ? "stop" : "warn"}`}>
          <b>{player.availability_overlay.effective === "OUT" ? "Indisponibile" : "In dubbio"}</b>
          <p style={{ marginTop: 4 }}>
            {player.availability_overlay.automatic?.reason || "Override manuale locale"}
            {player.availability_overlay.automatic
              ? ` · Rientro ${player.availability_overlay.automatic.expected_return || "non indicato"}${player.availability_overlay.automatic.return_date_source ? ` (${player.availability_overlay.automatic.return_date_source})` : ""} · Fonte Fantacalcio Online${player.availability_overlay.checkedAt ? ` · aggiornata ${player.availability_overlay.checkedAt.slice(0, 16).replace("T", " ")}` : ""}`
              : ""}
          </p>
        </div>
      ) : null}

      {auction ? <LiveAuctionPanel player={player} {...auction} /> : null}

      <label className="field" htmlFor="player-note">
        <span className="field-label">Le mie note</span>
        <textarea
          id="player-note"
          className="input textarea"
          value={mark?.note || ""}
          onChange={(event) => onNoteChange(event.target.value)}
          placeholder="Prezzo massimo, alternative, promemoria..."
          maxLength={noteMaxLength}
          rows={3}
        />
        <span className="field-help">
          Salvate solo in questo browser, separate per profilo.
        </span>
      </label>

      <div className="detail-figures">
        <div className="stat">
          <span className="stat-label">FVM fonte</span>
          <span className="stat-value">{sourceFvm(player).toFixed(2)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Valore ruolo</span>
          <span className="stat-value">
            {valuation.normalizedFvm(player).toFixed(2)}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Prob. voto</span>
          <span className="stat-value">
            {Math.round(player.proiezione.p_gioca * 100)}%
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Fantavoto</span>
          <span className="stat-value">
            {player.proiezione.fantavoto.toFixed(2)}
          </span>
        </div>
      </div>

      {outliers.length ? (
        <div className="notice notice--warn" role="note">
          <b>Valore da verificare</b>
          <ul
            className="bullets bullets--warn"
            style={{ marginTop: "var(--s-2)" }}
          >
            {outliers.map((outlier) => (
              <li key={outlier.code}>{outlier.label}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="quotes">
        <span className="muted">
          Quotazione <b>{player.quotazioni.attuale}</b>
        </span>
        <span className="muted">
          Iniziale <b>{player.quotazioni.iniziale}</b>
        </span>
        <span className={difference >= 0 ? "trend-up" : "trend-down"}>
          {difference >= 0 ? "+" : ""}
          {difference}
        </span>
      </div>

      <PlayerIntelligence intelligence={intelligence} />

      <div>
        <div className="section-head">
          <h2 style={{ fontSize: "var(--fs-md)" }}>Storico</h2>
        </div>
        {history.length ? (
          <table className="history-table">
            <thead>
              <tr>
                <th>Stagione</th>
                {HISTORY_COLUMNS.map(([, label]) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.map(([season, stat]) => (
                <tr key={season}>
                  <td>{season}</td>
                  {HISTORY_COLUMNS.map(([key]) => (
                    <td key={key}>{stat[key] ?? "—"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="micro">Nessuno storico nel listone.</p>
        )}
      </div>

      <div className="notice">
        <b>{player.disponibilita.status.replace("_", " ")}</b>
        <p style={{ marginTop: 4 }}>
          {player.disponibilita.nota || "Stima ricavata dallo storico."}
        </p>
      </div>

      <p className="micro">
        FVM fonte: colonna FVM del listone Fantacalcio su base 1000. Il valore
        ruolo la normalizza sul budget configurato per il reparto.
      </p>
    </div>
  );
}

export function PlayerIntelligence({ intelligence }) {
  const performance = intelligence?.performance || [];
  const market = intelligence?.market;
  const lineup = intelligence?.lineup;
  const compatible = market?.price_cohort_compatible;
  const price = compatible ? market?.market_price : market?.benchmark_market_price;
  const cohort = compatible ? market?.market_price_cohort : market?.benchmark_market_price_cohort;
  const sources = [["FC", lineup?.fc_pct], ["Gaz", lineup?.gaz_pct], ["SOS", lineup?.sos_pct], ["Sky", lineup?.sky_pct]];
  return <div className="p1-intelligence">
    <section>
      <div className="section-head"><h2>Rendimento</h2>{Number.isFinite(intelligence?.averageFc) && <span>MV FC {intelligence.averageFc.toFixed(2)}</span>}</div>
      {performance.length ? <div className="p1-performance">{performance.map((row) => <p key={row.matchday}>
        <b>G{row.matchday}</b><strong>{voteLabel(row.vote_fc)}</strong><span>{row.venue === "HOME" ? "vs" : "@"} {row.opponent}</span><small>{appearanceLabel(row)}{row.goals ? ` · ⚽ ${row.goals}` : ""}{row.assists ? ` · A ${row.assists}` : ""}{row.yellow_cards ? " · 🟨" : ""}{row.red_cards ? " · 🟥" : ""}</small>
      </p>)}</div> : <p className="micro">Prestazioni correnti non ancora disponibili.</p>}
    </section>
    <section>
      <div className="section-head"><h2>Mercato</h2></div>
      {market ? <dl className="p1-facts">
        <dt>Comprato da</dt><dd>{Number.isFinite(market.ownership_pct) ? `${market.ownership_pct.toFixed(1)}%` : "campione insufficiente"}</dd>
        <dt>7 giorni</dt><dd>{Number.isFinite(market.ownership_delta_7d) ? `${market.ownership_delta_7d >= 0 ? "+" : ""}${market.ownership_delta_7d.toFixed(1)} pp` : "—"}</dd>
        <dt>{compatible ? "Prezzo mercato" : "Benchmark FCO"}</dt><dd>{cohort ? (Number.isFinite(price?.value) ? price.value.toFixed(2) : market.new_player ? "Nuovo" : "—") : "Nessun benchmark singolo"}</dd>
        {cohort && <><dt>{compatible ? "Cohort" : "Benchmark FCO"}</dt><dd>{cohort.teams} squadre / {cohort.credits}</dd></>}
        {!compatible && <><dt>La tua lega</dt><dd>{market.active_league?.participants} squadre / {market.active_league?.credits} crediti</dd><dt>Confrontabilità</dt><dd>Non direttamente comparabile</dd></>}
        <dt>Ownership updated</dt><dd>{market.market_source_date}</dd>
        <dt>Prices updated</dt><dd>{market.price_source_date}</dd>
        <dt>Price season</dt><dd>{price?.fallback_previous_season ? `Prezzo ${price.price_season}` : price?.current_season ? price.price_season : "Non disponibile"}</dd>
      </dl> : <p className="micro">Mercato non ancora disponibile.</p>}
    </section>
    <section>
      <div className="section-head"><h2>Prossima partita</h2></div>
      {lineup ? <>
        <p className="p1-lineup-head"><b>{lineup.opponent} · {lineup.venue === "HOME" ? "casa" : "trasferta"}</b><strong>{Number.isFinite(lineup.weighted_pct) ? `${lineup.weighted_pct}%` : "—"}</strong></p>
        <div className="p1-sources">{sources.map(([label, value]) => <span key={label}><small>{label}</small><b>{Number.isFinite(value) ? value : "—"}</b></span>)}</div>
        <p className="micro">{lineup.source_count}/4 fonti · rilevazione {lineup.observation_at?.slice(0, 16).replace("T", " ")}</p>
      </> : <p className="micro">Probabilità prossima giornata non ancora disponibile.</p>}
    </section>
  </div>;
}

function LiveAuctionPanel({
  player,
  live,
  board,
  rules,
  owner,
  setOwner,
  price,
  setPrice,
  feedback,
  focusToken,
  advice,
  adviceFailure,
  onAssign,
  onRelease,
}) {
  const priceInput = useRef(null);
  useEffect(() => {
    if (!focusToken) return undefined;
    const frame = requestAnimationFrame(() => priceInput.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusToken]);

  const note = feedback ? (
    <p
      className={`notice notice--${feedback.ok ? "go" : "stop"}`}
      role="status"
      aria-live="polite"
    >
      {feedback.message}
    </p>
  ) : null;

  if (live)
    return (
      <div className="live-panel">
        <div className={`notice notice--${live.mine ? "go" : "info"}`}>
          <b>{live.mine ? "Preso da te" : `Preso da ${live.ownerName}`}</b>
          <p style={{ marginTop: 4 }}>{live.price} crediti</p>
        </div>
        <button type="button" className="btn btn--block" onClick={onRelease}>
          Rimetti tra i disponibili
        </button>
        {note}
      </div>
    );

  const buyer = board.teams[owner];
  const legalMax = buyer?.maxBid ?? 0;
  const blockedRole = board.activeRole && player.ruolo !== board.activeRole;
  const summary = advice?.summary || {};
  const forOther = owner !== board.userTeamIndex;
  const { tone, headline, recommendation, purpose } = bidVerdict({
    advice,
    price,
    rules,
    legalMax,
  });

  return (
    <div className="stack">
      <section
        className={`verdict verdict--bare${tone ? ` is-${tone}` : ""}`}
        aria-label={`Consiglio d'asta per ${player.nome}`}
      >
        <div className="verdict-call">
          <strong className="verdict-word">{headline}</strong>
          <span className="verdict-sub">
            {advice
              ? `Utilità: ${purpose} · prezzo: ${recommendation} · confidenza ${Math.round(advice.confidence * 100)}% · ${advice.utility}`
              : adviceFailure || "Sto valutando la rosa e il mercato."}
          </span>
        </div>

        <BidGauge
          advice={advice}
          price={price}
          rules={rules}
          legalMax={legalMax}
        />

        <div className="bidbar">
          <PriceStepper
            price={price}
            rules={rules}
            legalMax={legalMax}
            onPrice={setPrice}
            onSubmit={onAssign}
            inputRef={priceInput}
          />

          <div className="assign-row">
            <select
              className="select"
              value={owner}
              onChange={(event) => setOwner(Number(event.target.value))}
              aria-label="Squadra acquirente"
            >
              {board.teams.map((item) => (
                <option value={item.index} key={item.index}>
                  {item.index === board.userTeamIndex ? "→ " : ""}
                  {item.name} · {item.credits} cr.
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn--primary"
              onClick={onAssign}
              disabled={blockedRole}
            >
              Assegna
            </button>
          </div>

          <div className="bid-foot">
            <span className="micro">
              {blockedRole
                ? `Fase ${ROLE_LABELS[board.activeRole].toLowerCase()}: questo ruolo non è ancora in asta.`
                : `Massimo ${legalMax} crediti · ${buyer?.slotsLeft?.[player.ruolo] ?? 0} posti ${player.ruolo} liberi.`}
              {forOther
                ? " Stai registrando l'acquisto di un'altra squadra: il consiglio resta calcolato sulla tua."
                : ""}
            </span>
          </div>
        </div>

        <AdviceDetail advice={advice} />
      </section>

      {note}

      {advice ? (
        <div className="detail-figures">
          <div className="stat">
            <span className="stat-label">I tuoi crediti</span>
            <span className="stat-value">{summary.credits ?? "—"}</span>
            <span className="stat-note">max bid {advice.legalMax}</span>
          </div>
          <div className="stat">
            <span className="stat-label">
              Budget {ROLE_LABELS[player.ruolo].toLowerCase()}
            </span>
            <span className="stat-value">
              {summary.roleBudgetRemaining ?? "—"}
            </span>
            <span className="stat-note">
              di {summary.roleBudgetTarget ?? "—"} · tetto{" "}
              {summary.roleBudgetCap ?? "—"}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Concorrenza</span>
            <span className="stat-value">
              {summary.opponentAffordable ?? "—"}/
              {summary.opponentDemand ?? "—"}
            </span>
            <span className="stat-note">squadre che possono spendere</span>
          </div>
          <div className="stat">
            <span className="stat-label">Mercato</span>
            <span className="stat-value">
              {(summary.marketInflation ?? 1).toFixed(2)}x
            </span>
            <span className="stat-note">
              scarsità ruolo {Math.round((summary.roleScarcity ?? 0) * 100)}%
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );

}
