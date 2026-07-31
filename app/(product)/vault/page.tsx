"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import posthog from "posthog-js";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { LibraryDetailsDrawer } from "@/components/library/LibraryDetailsDrawer";
import { FilterPill } from "@/components/shared/FilterPill";
import { Artwork } from "@/components/shared/Artwork";
import { BrandedIcon } from "@/components/shared/BrandedIcon";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { ManagePinsDialog } from "@/components/shared/ManagePinsDialog";
import { VaultCollectionCard } from "@/components/vault/VaultCollectionCard";
import { VaultGenrePanel } from "@/components/vault/VaultGenrePanel";
import { VaultLens } from "@/components/vault/VaultLens";
import { VaultHistoryDrawer } from "@/components/vault/VaultHistoryDrawer";
import { VaultOptionGroup } from "@/components/vault/VaultOptionGroup";
import { VaultPoolPreview } from "@/components/vault/VaultPoolPreview";
import { type DemoGame, type VaultGoalId, type VaultMoodId, type VaultSessionId } from "@/lib/demo-data";
import {
  buildVaultDeck,
  buildVaultPool,
  drawVaultGame,
  getVaultEligibility,
  MAX_VAULT_GENRES,
  vaultGoalOptions,
  vaultMoodOptions,
  vaultSessionOptions
} from "@/lib/vault";
import { steamStoreUrl } from "@/lib/steam-images";
import { formatGameDuration } from "@/lib/game-duration";
import type { VaultDraw } from "@/lib/vault-history";
import styles from "./vault.module.css";

type VaultDrawState = "idle" | "focusing" | "revealing" | "revealed" | "error";
type DeferredDeckQueue = { setupKey: string; gameIds: string[] };
const EMPTY_GAME_IDS: string[] = [];

export default function VaultPage() {
  const { games, collections, vaultState, vaultHistory, recordVaultAction, recordVaultDraw, loadVaultHistory, recordDrawEvent, clearVaultHistory, updateGame, restoreGame, setGameCollection } = useAppData();
  const [session, setSession] = useState<VaultSessionId | null>(null);
  const [mood, setMood] = useState<VaultMoodId | null>(null);
  const [goal, setGoal] = useState<VaultGoalId | null>(null);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [highlightedGameId, setHighlightedGameId] = useState<string | null>(null);
  const [detailsGameId, setDetailsGameId] = useState<string | null>(null);
  const [savingGameId, setSavingGameId] = useState<string | null>(null);
  const [sleepingGameId, setSleepingGameId] = useState<string | null>(null);
  const [sleepUndo, setSleepUndo] = useState<{ gameId: string; title: string; status: "Not Started" | "In Progress"; wasPinned: boolean } | null>(null);
  const [pinCandidate, setPinCandidate] = useState<DemoGame | null>(null);
  const [pinMessage, setPinMessage] = useState("");
  const [completionUndo, setCompletionUndo] = useState<{ id: string; title: string } | null>(null);
  const [drawState, setDrawState] = useState<VaultDrawState>("idle");
  const [drawWinnerId, setDrawWinnerId] = useState<string | null>(null);
  const [drawMessage, setDrawMessage] = useState("");
  const [lensOpen, setLensOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [currentDrawId, setCurrentDrawId] = useState<string | null>(null);
  const pendingHistoryDrawRef = useRef(false);
  const drawingRef = useRef(false);
  const resultRef = useRef<HTMLElement>(null);
  const drawnCycleRef = useRef<Set<string>>(new Set());
  const deferredQueueRef = useRef<DeferredDeckQueue>({ setupKey: "", gameIds: [] });
  const [deferredQueue, setDeferredQueue] = useState<DeferredDeckQueue>({ setupKey: "", gameIds: [] });

  const ownedGames = useMemo(() => games.filter((game) => game.ownership === "Owned"), [games]);
  const snoozedIds = useMemo(() => new Set(vaultState.snoozedIds), [vaultState.snoozedIds]);
  const selectedCollection = collections.find((collection) => collection.id === selectedCollectionId) ?? null;
  const entireVault = collections.find((collection) => collection.id === "all") ?? collections[0];
  const collectionCounts = useMemo(() => Object.fromEntries(collections.map((collection) => [collection.id, collection.id === "all" ? ownedGames.length : ownedGames.filter((game) => game.collectionIds.includes(collection.id)).length])), [collections, ownedGames]);
  const setupKey = `${session ?? ""}|${mood ?? ""}|${goal ?? ""}|${selectedCollectionId ?? "all"}|${selectedGenres.toSorted().join(",")}`;

  const fullPool = useMemo(
    () =>
      buildVaultPool({
        games: ownedGames,
        session,
        mood,
        goal,
        selectedCollectionId,
        selectedGenres,
        snoozedIds
      }),
    [goal, mood, ownedGames, selectedCollectionId, selectedGenres, session, snoozedIds]
  );
  const activeDeferredGameIds = deferredQueue.setupKey === setupKey ? deferredQueue.gameIds : EMPTY_GAME_IDS;
  const deck = useMemo(() => buildVaultDeck(fullPool, activeDeferredGameIds), [activeDeferredGameIds, fullPool]);
  const eligibility = useMemo(() => getVaultEligibility({
    games: ownedGames,
    session,
    mood,
    goal,
    selectedCollectionId,
    selectedCollectionName: selectedCollection?.name,
    selectedGenres,
    snoozedIds
  }), [goal, mood, ownedGames, selectedCollection?.name, selectedCollectionId, selectedGenres, session, snoozedIds]);

  const currentPick = ownedGames.find((game) =>
    game.id === vaultState.currentPickId &&
    game.status !== "Completed" &&
    game.status !== "Slept" &&
    !snoozedIds.has(game.id)
  ) ?? null;
  const detailsGame = ownedGames.find((game) => game.id === detailsGameId) ?? null;
  const missingSetup = [!session ? "Session" : "", !mood ? "Mood" : "", !goal ? "Goal" : ""].filter(Boolean);
  const canDraw = missingSetup.length === 0 && deck.length > 0;

  useEffect(() => {
    const resetQueue = { setupKey, gameIds: [] };
    drawnCycleRef.current.clear();
    deferredQueueRef.current = resetQueue;
    setDeferredQueue(resetQueue);
    setHighlightedGameId(null);
  }, [setupKey]);

  useEffect(() => {
    if (!deck.length) setLensOpen(true);
  }, [deck.length]);

  async function handleOpenVault({ deferCurrentPick = false }: { deferCurrentPick?: boolean } = {}) {
    if (drawingRef.current || !canDraw) return;

    let activeDeck = deck;
    if (deferCurrentPick && currentPick && fullPool.some((entry) => entry.game.id === currentPick.id)) {
      const currentDeferredIds = deferredQueueRef.current.setupKey === setupKey
        ? deferredQueueRef.current.gameIds
        : [];
      const nextDeferredIds = [
        ...currentDeferredIds.filter((gameId) => gameId !== currentPick.id),
        currentPick.id
      ];
      const nextQueue = { setupKey, gameIds: nextDeferredIds };
      deferredQueueRef.current = nextQueue;
      setDeferredQueue(nextQueue);
      activeDeck = buildVaultDeck(fullPool, nextDeferredIds);
    }

    let availablePool = activeDeck.filter((entry) => !drawnCycleRef.current.has(entry.game.id));
    if (!availablePool.length) {
      drawnCycleRef.current.clear();
      availablePool = activeDeck;
    }
    const nextPick = drawVaultGame(availablePool, currentPick?.id);
    if (!nextPick) return;
    drawnCycleRef.current.add(nextPick.id);

    drawingRef.current = true;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setDrawWinnerId(nextPick.id);
    setHighlightedGameId(null);
    setDrawMessage("Opening the Vault.");
    setDrawState("focusing");

    try {
      await wait(reducedMotion ? 80 : 480);
      setDrawState("revealing");
      await wait(reducedMotion ? 100 : 370);

      const draw = await recordVaultDraw(nextPick.id, {
        steamAppId: nextPick.steamAppId,
        session: session!, mood: mood!, goal: goal!, collectionId: selectedCollectionId,
        selectedGenres, eligiblePoolCount: fullPool.length, rerollIndex: drawnCycleRef.current.size - 1
      });
      setCurrentDrawId(draw.id);
      setHighlightedGameId(nextPick.id);
      setDrawState("revealed");
      setDrawMessage(`Vault opened. ${nextPick.title} selected.`);
      posthog.capture('vault_draw', {
        session,
        mood,
        goal,
        collection_selected: Boolean(selectedCollectionId),
        genre_count: selectedGenres.length,
        pool_size: fullPool.length,
        deck_size: activeDeck.length,
        reroll_index: drawnCycleRef.current.size - 1,
      });
      requestAnimationFrame(() => revealResultIfNeeded(resultRef.current, reducedMotion));
    } catch (error) {
      console.error("Vault draw failed", error);
      drawnCycleRef.current.delete(nextPick.id);
      setDrawState("error");
      setDrawMessage("The Vault could not complete the draw. Please try again.");
    } finally {
      drawingRef.current = false;
    }
  }

  function useHistorySetup(draw: VaultDraw, drawNow: boolean) {
    setSession(draw.session); setMood(draw.mood); setGoal(draw.goal);
    setSelectedCollectionId(collections.some((collection) => collection.id === draw.collectionId) ? draw.collectionId : null);
    setSelectedGenres(draw.selectedGenres.slice(0, MAX_VAULT_GENRES));
    pendingHistoryDrawRef.current = drawNow;
    setHistoryOpen(false);
  }

  useEffect(() => {
    if (!pendingHistoryDrawRef.current || !canDraw) return;
    pendingHistoryDrawRef.current = false;
    void handleOpenVault();
  }, [canDraw, deck.length, goal, mood, selectedCollectionId, selectedGenres, session]);

  function toggleGenre(genre: string) {
    setSelectedGenres((current) => {
      if (current.includes(genre)) return current.filter((item) => item !== genre);
      if (current.length >= MAX_VAULT_GENRES) return current;
      return [...current, genre];
    });
  }

  function clearGenres() {
    setSelectedGenres([]);
  }

  async function clearSnoozes() {
    await Promise.all(vaultState.snoozedIds.map((gameId) => recordVaultAction("unsnoozed", gameId)));
  }

  async function togglePin(id: string) {
    const game = ownedGames.find((item) => item.id === id);
    if (!game) return;
    if (vaultState.pinnedIds.includes(id)) {
      await recordVaultAction("unpinned", id);
      setPinMessage(`${game.title} unpinned.`);
      return;
    }
    if (vaultState.pinnedIds.length >= 3) {
      setPinCandidate(game);
      return;
    }
    await recordVaultAction("pinned", id);
    setPinMessage(`${game.title} pinned in slot ${vaultState.pinnedIds.length + 1} of 3.`);
  }

  async function snoozeCurrentPick() {
    if (!currentPick) return;
    await recordVaultAction("snoozed", currentPick.id);
    setHighlightedGameId(null);
  }

  async function sleepPoolGame(gameId: string) {
    const game = ownedGames.find((item) => item.id === gameId);
    if (!game || game.status === "Completed" || game.status === "Slept") return;
    const previousStatus = game.status === "In Progress" ? "In Progress" : "Not Started";
    const wasPinned = vaultState.pinnedIds.includes(gameId);
    setSleepingGameId(gameId);
    try {
      await updateGame(gameId, { status: "Slept", sleptAt: new Date().toISOString() });
      setSleepUndo({ gameId, title: game.title, status: previousStatus, wasPinned });
    } finally {
      setSleepingGameId(null);
    }
  }

  async function undoSleep() {
    if (!sleepUndo) return;
    const undo = sleepUndo;
    setSleepUndo(null);
    await updateGame(undo.gameId, { status: undo.status, sleptAt: null });
    if (undo.wasPinned && vaultState.pinnedIds.length < 3) await recordVaultAction("pinned", undo.gameId);
  }

  async function completeGame(game: DemoGame) {
    await updateGame(game.id, { status: "Completed" });
    setHighlightedGameId(null);
    setCompletionUndo({ id: game.id, title: game.title });
  }

  async function undoCompletion() {
    if (!completionUndo) return;
    const gameId = completionUndo.id;
    setCompletionUndo(null);
    await restoreGame(gameId);
  }

  return (
    <section className={styles.vaultPage}>
      <div className={styles.heroPanel}>
        <h1 className="visually-hidden">Vault</h1>
      </div>

      <section className={styles.setupLayout} aria-label="Vault preferences, collection and genres">
        <div className={styles.optionStack}>
          <VaultOptionGroup title="Session" options={vaultSessionOptions} selectedId={session} onSelect={(id) => setSession(id as VaultSessionId)} />
          <VaultOptionGroup title="Mood" options={vaultMoodOptions} selectedId={mood} onSelect={(id) => setMood(id as VaultMoodId)} />
          <VaultOptionGroup title="Goal" options={vaultGoalOptions} selectedId={goal} onSelect={(id) => setGoal(id as VaultGoalId)} />
        </div>

        <div className={styles.setupStack}>
          <div className={styles.genreSetup}>
            <VaultGenrePanel
              selectedGenres={selectedGenres}
              onToggleGenre={toggleGenre}
              onClear={clearGenres}
            />
          </div>
          <div className={styles.collectionSetup}>
            <VaultCollectionCard
              selectedCollection={selectedCollection ?? entireVault}
              collections={collections}
              collectionCounts={collectionCounts}
              onSelect={(id) => setSelectedCollectionId(id === "all" ? null : id)}
            />
          </div>
        </div>
      </section>

      <section className={styles.poolSection} id="vault-pool">
        <div className={styles.poolControls}>
          <div className={styles.poolHeader}>
            <div className={styles.poolIdentity}><p className={styles.poolLabel}>Vault Deck</p><span className={styles.matchBadge}><VaultIcon name="new" size={15} />{deck.length}{fullPool.length > deck.length ? ` of ${fullPool.length}` : ""} matches</span></div>
            <div className={styles.deckTools}>
              <button
                type="button"
                className={styles.deckToolButton}
                data-active={lensOpen || undefined}
                aria-expanded={lensOpen}
                aria-controls="vault-lens-panel"
                onClick={() => setLensOpen((value) => !value)}
              >
                <span className={styles.deckToolIcon}><VaultIcon name="details" size={21} /></span>
                <span className={styles.deckToolCopy}><strong>Vault Lens</strong><small>How this deck was built</small></span>
                <VaultIcon className={styles.deckToolChevron} name="chevron-down" size={17} />
              </button>
              <button
                type="button"
                className={styles.deckToolButton}
                aria-expanded={historyOpen}
                aria-haspopup="dialog"
                onClick={() => { setHistoryOpen(true); void loadVaultHistory(); }}
              >
                <span className={styles.deckToolIcon}><VaultIcon name="clock" size={21} /></span>
                <span className={styles.deckToolCopy}><strong>Draw History</strong><small>Revisit previous picks</small></span>
                <VaultIcon className={styles.deckToolArrow} name="chevron-right" size={17} />
              </button>
            </div>
          </div>

          {lensOpen ? <VaultLens stages={eligibility.stages} selectedCollection={Boolean(selectedCollectionId)} selectedGenres={Boolean(selectedGenres.length)} snoozedCount={snoozedIds.size} onClearGenres={clearGenres} onUseEntireVault={() => setSelectedCollectionId(null)} onClearSnoozes={() => void clearSnoozes()} /> : null}

          <div className={styles.pillRow}>
            {selectedCollection ? <FilterPill label={selectedCollection.name} /> : null}
            {session ? <FilterPill label={vaultSessionOptions.find((option) => option.id === session)?.label ?? "Session"} /> : null}
            {mood ? <FilterPill label={vaultMoodOptions.find((option) => option.id === mood)?.label ?? "Mood"} /> : null}
            {goal ? <FilterPill label={vaultGoalOptions.find((option) => option.id === goal)?.label ?? "Goal"} /> : null}
            {selectedGenres.map((genre) => <FilterPill key={genre} label={genre} removable onRemove={() => toggleGenre(genre)} />)}
            {!selectedCollection && !session && !mood && !goal && !selectedGenres.length ? <span className={styles.noFilters}>No filters selected</span> : null}
          </div>
        </div>

        {deck.length ? (
          <VaultPoolPreview
            entries={deck}
            drawState={drawState}
            winner={ownedGames.find((game) => game.id === drawWinnerId) ?? null}
            highlightedId={highlightedGameId}
            onSelect={setDetailsGameId}
            sleepingId={sleepingGameId}
            onSleep={(id) => void sleepPoolGame(id)}
            pinnedIds={vaultState.pinnedIds}
            onPin={(id) => void togglePin(id)}
            onComplete={(id) => {
              const game = ownedGames.find((item) => item.id === id);
              if (game) void completeGame(game);
            }}
            onUserScroll={() => setHighlightedGameId(null)}
          />
        ) : (
          <div className={styles.emptyState}>
            <h3 className={styles.emptyTitle}>No games matched that combination.</h3>
            <p className={styles.emptyCopy}>Try loosening the genre filters or switch to Surprise Me for a wider pool.</p>
            <button type="button" className={styles.secondaryAction} onClick={clearGenres}>
              Clear genre filters
            </button>
          </div>
        )}

        <div className={styles.poolActionArea}>
          <button type="button" className={styles.ctaButton} onClick={() => void handleOpenVault()} disabled={!canDraw || drawingRef.current} aria-busy={drawingRef.current} aria-describedby="vault-setup-status">
            <BrandedIcon group="actions" name="draw-from-vault" size={24} />{drawState === "focusing" || drawState === "revealing" ? "Drawing from the Vault…" : "Draw from the Vault"}
          </button>
          <p className={styles.setupStatus} id="vault-setup-status">{missingSetup.length ? `Choose ${formatMissingSetup(missingSetup)}.` : !deck.length ? "No games match this setup." : "Your setup is ready."}</p>
        </div>
      </section>

      <p className="visually-hidden" aria-live="polite">{drawMessage}</p>

      {currentPick ? (
        <section ref={resultRef} className={`${styles.resultCard} ${drawState === "revealed" ? styles.resultRevealed : ""}`} data-visible={drawState === "revealed"}>
          <div className={styles.resultArtwork}>
            <Artwork src={currentPick.bannerUrl} sizes="(max-width: 820px) 100vw, 42vw" priority fit="contain" />
            <span className={styles.currentPickBadge}><img src="/assets/vaultshuffle/site-icons/utility/current-pick.svg" alt="" width={18} height={18} aria-hidden="true" />Current pick</span>
          </div>
          <div className={styles.resultBody}>
            <div className={styles.resultHeading}><h2 className={styles.resultTitle}>{currentPick.title}</h2><VaultIcon name="new" size={22} /></div>
            <p className={styles.resultCopy}>{currentPick.description}</p>
            <p className={styles.reasonLabel}>Why it&apos;s a great match</p>
            <div className={styles.resultReasonRow}>
              {(fullPool.find((entry) => entry.game.id === currentPick.id)?.reasons ?? []).map((reason) => <FilterPill key={reason} label={reason} />)}
            </div>
            <p className={styles.actionsLabel}>Vault actions</p>
            <div className={styles.resultActions}>
              <a href={steamStoreUrl(currentPick.steamAppId)} className={`${styles.resultAction} ${styles.resultActionPrimary}`} target="_blank" rel="noreferrer" onClick={() => currentDrawId ? void recordDrawEvent(currentDrawId, "opened_on_steam") : undefined}>
                <VaultResultActionIcon name="open-steam" /><span className={styles.resultActionCopy}><strong>Open on Steam</strong><small>Launch the game</small></span>
              </a>
              <button type="button" className={styles.resultAction} onClick={() => { void togglePin(currentPick.id); if (currentDrawId) void recordDrawEvent(currentDrawId, vaultState.pinnedIds.includes(currentPick.id) ? "unpinned" : "pinned"); }}>
                <VaultResultActionIcon name="pin" /><span className={styles.resultActionCopy}><strong>{vaultState.pinnedIds.includes(currentPick.id) ? `Pinned · ${vaultState.pinnedIds.length}/3` : vaultState.pinnedIds.length >= 3 ? "Pins Full · 3/3" : `Pin This Pick · ${vaultState.pinnedIds.length}/3`}</strong><small>Pinned Library shelf</small></span>
              </button>
              <button type="button" className={styles.resultAction} onClick={() => { if (currentDrawId) void recordDrawEvent(currentDrawId, "drew_again"); void handleOpenVault({ deferCurrentPick: true }); }}>
                <VaultResultActionIcon name="draw-again" /><span className={styles.resultActionCopy}><strong>Draw Again</strong><small>Find something else</small></span>
              </button>
              <button type="button" className={styles.resultAction} onClick={() => { if (currentDrawId) void recordDrawEvent(currentDrawId, "hidden_for_session"); void snoozeCurrentPick(); }}>
                <VaultResultActionIcon name="snooze-not-now" /><span className={styles.resultActionCopy}><strong>Not Now</strong><small>Snooze this pick</small></span>
              </button>
              <button type="button" className={styles.resultAction} onClick={() => setDetailsGameId(currentPick.id)}>
                <VaultResultActionIcon name="view-details" /><span className={styles.resultActionCopy}><strong>View Details</strong><small>See progress, notes and collections</small></span>
              </button>
              <button type="button" className={styles.resultAction} onClick={() => { if (currentDrawId) void recordDrawEvent(currentDrawId, "marked_completed"); void completeGame(currentPick); }}>
                <VaultResultActionIcon name="mark-completed" /><span className={styles.resultActionCopy}><strong>Mark as Completed</strong><small>Archive this game</small></span>
              </button>
            </div>
          </div>
          <aside className={styles.resultContext} aria-label="Selected setup">
            <ResultSummary icon="clock" label="Session" value={vaultSessionOptions.find((option) => option.id === session)?.label ?? "Not selected"} />
            <ResultSummary icon="mood" label="Mood" value={vaultMoodOptions.find((option) => option.id === mood)?.label ?? "Not selected"} />
            <ResultSummary icon="goal" label="Goal" value={vaultGoalOptions.find((option) => option.id === goal)?.label ?? "Not selected"} />
            <ResultSummary icon="genre" label="Genres / context" value={selectedGenres.length ? selectedGenres.join(" · ") : selectedCollection?.name ?? "Entire Vault"} />
            {formatGameDuration(currentPick.duration) ? <ResultSummary icon="clock" label="Estimated playthrough" value={formatGameDuration(currentPick.duration)!} /> : null}
          </aside>
        </section>
      ) : null}

      <LibraryDetailsDrawer
        game={detailsGame}
        collections={collections}
        saving={savingGameId === detailsGame?.id}
        onSave={async (patch) => {
          if (!detailsGame) return;
          setSavingGameId(detailsGame.id);
          try {
            await updateGame(detailsGame.id, patch);
          } finally {
            setSavingGameId(null);
          }
        }}
        onToggleCollection={async (collectionId, assigned) => {
          if (!detailsGame) return;
          await setGameCollection(detailsGame.id, collectionId, assigned);
        }}
        onClose={() => setDetailsGameId(null)}
        onComplete={() => detailsGame ? completeGame(detailsGame) : Promise.resolve()}
        onRestore={() => detailsGame ? restoreGame(detailsGame.id) : Promise.resolve()}
      />
      <VaultHistoryDrawer open={historyOpen} draws={vaultHistory} games={ownedGames} collections={collections} onClose={() => setHistoryOpen(false)} onClear={clearVaultHistory} onUseSetup={useHistorySetup} onPin={(game) => void togglePin(game.id)} onEvent={(drawId, type) => void recordDrawEvent(drawId, type)} />
      {sleepUndo ? <div className={styles.sleepToast} role="status"><span>{sleepUndo.title} is sleeping{sleepUndo.wasPinned ? " and was removed from your pins" : " and will stay out of Vault draws"}.</span><button type="button" onClick={() => void undoSleep()}>Undo</button></div> : null}
      {pinMessage ? <div className={styles.pinToast} role="status">{pinMessage}<button type="button" onClick={() => setPinMessage("")}>Dismiss</button></div> : null}
      {completionUndo ? <div className={styles.pinToast} role="status">{completionUndo.title} marked as completed.<button type="button" onClick={() => void undoCompletion()}>Undo</button></div> : null}
      {pinCandidate ? <ManagePinsDialog pinnedGames={vaultState.pinnedIds.map((id) => ownedGames.find((game) => game.id === id)).filter((game): game is NonNullable<typeof game> => Boolean(game))} candidate={pinCandidate} onRemove={async (id) => { await recordVaultAction("unpinned", id); }} onReplace={async (replaceId) => { await recordVaultAction("pinned", pinCandidate.id, { replace_game_id: replaceId }); setPinMessage(`${pinCandidate.title} replaced ${ownedGames.find((game) => game.id === replaceId)?.title ?? "a pinned game"}.`); }} onClose={() => setPinCandidate(null)} /> : null}
    </section>
  );
}

function wait(duration: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, duration));
}

function revealResultIfNeeded(element: HTMLElement | null, reducedMotion: boolean) {
  if (!element) return;
  const bounds = element.getBoundingClientRect();
  const isBelowViewport = bounds.top > window.innerHeight - 80;
  if (isBelowViewport) element.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
}

function formatMissingSetup(items: string[]) {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function ResultSummary({ icon, label, value }: { icon: "clock" | "mood" | "goal" | "genre"; label: string; value: string }) {
  return <div className={styles.summaryItem}><VaultIcon name={icon} size={23} /><span><small>{label}</small><strong>{value}</strong></span></div>;
}

type VaultResultActionIconName = "open-steam" | "pin" | "draw-again" | "snooze-not-now" | "view-details" | "mark-completed";

function VaultResultActionIcon({ name }: { name: VaultResultActionIconName }) {
  return <span className={styles.resultActionIcon} aria-hidden="true"><img src={`/assets/vaultshuffle/site-icons/actions/${name}.svg`} alt="" width={48} height={48} /></span>;
}
