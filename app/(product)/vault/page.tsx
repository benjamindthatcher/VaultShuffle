"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { LibraryDetailsDrawer } from "@/components/library/LibraryDetailsDrawer";
import { FilterPill } from "@/components/shared/FilterPill";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { ManagePinsDialog } from "@/components/shared/ManagePinsDialog";
import { VaultCollectionCard } from "@/components/vault/VaultCollectionCard";
import { VaultGenrePanel } from "@/components/vault/VaultGenrePanel";
import { VaultLens } from "@/components/vault/VaultLens";
import { VaultHistoryDrawer } from "@/components/vault/VaultHistoryDrawer";
import { GuestSignInPrompt } from "@/components/vault/GuestSignInPrompt";
import { VaultOptionGroup } from "@/components/vault/VaultOptionGroup";
import { VaultPoolPreview } from "@/components/vault/VaultPoolPreview";
import { type DemoGame, type VaultGoalId, type VaultMoodId, type VaultSessionId } from "@/lib/demo-data";
import {
  buildVaultDeck,
  buildVaultPool,
  drawVaultGame,
  drawQuickVaultGame,
  getVaultEligibility,
  isCollectionDraw,
  MAX_VAULT_GENRES,
  vaultGoalOptions,
  vaultMoodOptions,
  vaultSessionOptions
} from "@/lib/vault";
import { steamLaunchUrl, steamStoreUrl } from "@/lib/steam-images";
import { formatGameDuration } from "@/lib/game-duration";
import { ANALYTICS_EVENTS, trackEvent, trackNavigationEvent } from "@/lib/analytics";
import styles from "./vault.module.css";

type VaultDrawState = "idle" | "focusing" | "revealing" | "revealed" | "error";
type VaultSetupStep = "session" | "mood" | "goal";
type VaultDrawMode = "vault" | "collection";
type DeferredDeckQueue = { setupKey: string; gameIds: string[] };
const EMPTY_GAME_IDS: string[] = [];
const GUEST_SIGN_IN_PROMPT_KEY = "vaultshuffle:guest-first-draw-prompt:v1";

export default function VaultPage() {
  const { games, collections, vaultState, vaultHistory, isLive, recordVaultAction, recordVaultDraw, loadVaultHistory, recordDrawEvent, clearVaultHistory, updateGame, restoreGame, setGameCollection } = useAppData();
  const [session, setSession] = useState<VaultSessionId | null>(null);
  const [mood, setMood] = useState<VaultMoodId | null>(null);
  const [goal, setGoal] = useState<VaultGoalId | null>(null);
  const [openSetupStep, setOpenSetupStep] = useState<VaultSetupStep>("session");
  const [drawMode, setDrawMode] = useState<VaultDrawMode>("vault");
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
  const [guestSignInOpen, setGuestSignInOpen] = useState(false);
  const guestDrawCountRef = useRef(0);
  const drawingRef = useRef(false);
  const resultRef = useRef<HTMLElement>(null);
  const drawnCycleRef = useRef<Set<string>>(new Set());
  const activeDrawRef = useRef(0);
  const deferredQueueRef = useRef<DeferredDeckQueue>({ setupKey: "", gameIds: [] });
  const guestPromptQueuedRef = useRef(false);
  const guestPromptTimerRef = useRef<number | null>(null);
  const [deferredQueue, setDeferredQueue] = useState<DeferredDeckQueue>({ setupKey: "", gameIds: [] });

  const ownedGames = useMemo(() => games.filter((game) => game.ownership === "Owned"), [games]);
  const snoozedIds = useMemo(() => new Set(vaultState.snoozedIds), [vaultState.snoozedIds]);
  const drawableGames = useMemo(() => ownedGames.filter((game) => game.status !== "Completed" && game.status !== "Slept" && !snoozedIds.has(game.id)), [ownedGames, snoozedIds]);
  const selectedCollection = collections.find((collection) => collection.id === selectedCollectionId) ?? null;
  const entireVault = collections.find((collection) => collection.id === "all") ?? collections[0];
  const collectionCounts = useMemo(() => Object.fromEntries(collections.map((collection) => [collection.id, collection.id === "all" ? drawableGames.length : drawableGames.filter((game) => game.collectionIds.includes(collection.id)).length])), [collections, drawableGames]);
  const collectionMode = drawMode === "collection";
  const collectionDraw = collectionMode && isCollectionDraw(selectedCollectionId);
  const activeSession = collectionMode ? null : session;
  const activeMood = collectionMode ? null : mood;
  const activeGoal = collectionMode ? null : goal;
  const activeCollectionId = collectionMode ? selectedCollectionId : null;
  const activeGenres = collectionMode ? EMPTY_GAME_IDS : selectedGenres;
  const setupKey = `${drawMode}|${activeSession ?? ""}|${activeMood ?? ""}|${activeGoal ?? ""}|${activeCollectionId ?? "all"}|${activeGenres.toSorted().join(",")}`;

  const fullPool = useMemo(
    () => {
      if (drawMode === "collection" && !activeCollectionId) return [];
      return buildVaultPool({
        games: ownedGames,
        session: activeSession,
        mood: activeMood,
        goal: activeGoal,
        selectedCollectionId: activeCollectionId,
        selectedGenres: activeGenres,
        snoozedIds
      });
    },
    [activeCollectionId, activeGenres, activeGoal, activeMood, activeSession, drawMode, ownedGames, snoozedIds]
  );
  const quickPool = useMemo(
    () => buildVaultPool({
      games: ownedGames,
      session: null,
      mood: null,
      goal: null,
      selectedCollectionId: null,
      selectedGenres: EMPTY_GAME_IDS,
      snoozedIds
    }),
    [ownedGames, snoozedIds]
  );
  const activeDeferredGameIds = deferredQueue.setupKey === setupKey ? deferredQueue.gameIds : EMPTY_GAME_IDS;
  const deck = useMemo(() => buildVaultDeck(fullPool, activeDeferredGameIds), [activeDeferredGameIds, fullPool]);
  const eligibility = useMemo(() => {
    if (collectionMode && !activeCollectionId) return { stages: [], games: [] };

    return getVaultEligibility({
      games: ownedGames,
      session: activeSession,
      mood: activeMood,
      goal: activeGoal,
      selectedCollectionId: activeCollectionId,
      selectedCollectionName: collectionDraw ? selectedCollection?.name : null,
      selectedGenres: activeGenres,
      snoozedIds
    });
  }, [activeCollectionId, activeGenres, activeGoal, activeMood, activeSession, collectionDraw, collectionMode, ownedGames, selectedCollection?.name, snoozedIds]);

  const currentPick = ownedGames.find((game) =>
    game.id === drawWinnerId &&
    game.status !== "Completed" &&
    game.status !== "Slept" &&
    !snoozedIds.has(game.id)
  ) ?? null;
  const detailsGame = ownedGames.find((game) => game.id === detailsGameId) ?? null;
  const canDraw = collectionMode
    ? Boolean(collectionDraw && deck.length > 0)
    : Boolean(session && mood && goal && deck.length > 0);
  const sessionLabel = vaultSessionOptions.find((option) => option.id === session)?.label ?? null;
  const moodLabel = vaultMoodOptions.find((option) => option.id === mood)?.label ?? null;
  const goalLabel = vaultGoalOptions.find((option) => option.id === goal)?.label ?? null;
  const setupReadyCount = Number(Boolean(session)) + Number(Boolean(mood)) + Number(Boolean(goal));
  const nextSetupStep: VaultSetupStep | null = !session ? "session" : !mood ? "mood" : !goal ? "goal" : null;
  const setupSteps: Array<{ id: VaultSetupStep; label: string; value: string | null }> = [
    { id: "session", label: "Session", value: sessionLabel },
    { id: "mood", label: "Mood", value: moodLabel },
    { id: "goal", label: "Goal", value: goalLabel }
  ];
  const drawButtonLabel = drawState === "focusing" || drawState === "revealing"
    ? "Drawing from the Vault…"
    : collectionMode && !selectedCollection
      ? "Choose a collection"
      : collectionMode && !deck.length
        ? "Collection has no games"
        : collectionMode
          ? `Draw from ${selectedCollection?.name ?? "collection"}`
    : nextSetupStep === "session"
      ? "Choose a session"
      : nextSetupStep === "mood"
        ? "Choose your mood"
        : nextSetupStep === "goal"
          ? "Choose your goal"
          : !deck.length
            ? "No matching games"
            : "Draw from the Vault";
  const setupStatusMessage = collectionMode && !selectedCollection
    ? "Choose one of your collections to make it the complete draw pool."
    : collectionMode && !deck.length
      ? "This collection has no active games available to draw."
      : collectionMode
        ? `Only active games in ${selectedCollection?.name ?? "this collection"} are eligible.`
    : nextSetupStep === "session"
    ? "Start by choosing how much time you have."
    : nextSetupStep === "mood"
      ? "Great. Now choose the kind of mood you are in."
      : nextSetupStep === "goal"
        ? "One final choice: what should tonight achieve?"
        : !deck.length
          ? "No games match this setup. Try loosening the optional filters."
          : "All three choices are ready. Open the Vault when you are ready.";
  const closeGuestSignInPrompt = useCallback(() => setGuestSignInOpen(false), []);

  useEffect(() => {
    const resetQueue = { setupKey, gameIds: [] };
    activeDrawRef.current += 1;
    drawingRef.current = false;
    drawnCycleRef.current.clear();
    deferredQueueRef.current = resetQueue;
    setDeferredQueue(resetQueue);
    setHighlightedGameId(null);
    setDrawWinnerId(null);
    setCurrentDrawId(null);
    setDrawState("idle");
    setDrawMessage("");
  }, [setupKey]);

  useEffect(() => {
    if (!deck.length) setLensOpen(true);
  }, [deck.length]);

  useEffect(() => () => {
    if (guestPromptTimerRef.current !== null) window.clearTimeout(guestPromptTimerRef.current);
  }, []);

  // The prompt used to open 650ms after a guest's very first draw, which covered
  // the result they had just asked for. A guest who has drawn three times is
  // clearly getting something out of it and has earned the interruption; one who
  // has drawn once has not decided anything yet.
  const GUEST_PROMPT_AFTER_DRAWS = 3;

  function queueGuestSignInPrompt() {
    if (isLive || guestPromptQueuedRef.current) return;

    guestDrawCountRef.current += 1;
    if (guestDrawCountRef.current < GUEST_PROMPT_AFTER_DRAWS) return;

    try {
      if (window.sessionStorage.getItem(GUEST_SIGN_IN_PROMPT_KEY)) {
        guestPromptQueuedRef.current = true;
        return;
      }
    } catch {
      // The in-memory guard still prevents repeat prompts when storage is unavailable.
    }

    guestPromptQueuedRef.current = true;
    guestPromptTimerRef.current = window.setTimeout(() => {
      try {
        window.sessionStorage.setItem(GUEST_SIGN_IN_PROMPT_KEY, "shown");
      } catch {
        // Private browsing can disable storage; showing the prompt should still work.
      }
      setGuestSignInOpen(true);
      guestPromptTimerRef.current = null;
    }, 1400);
  }

  async function handleOpenVault({ deferCurrentPick = false, quick = false }: { deferCurrentPick?: boolean; quick?: boolean } = {}) {
    // Quick Draw bypasses the setup gate on purpose: it exists for the visitor who
    // has not filled anything in and wants a game anyway.
    if (drawingRef.current || (!quick && !canDraw)) return;
    if (quick && !quickPool.length) return;
    const activeDraw = activeDrawRef.current + 1;
    activeDrawRef.current = activeDraw;

    let activeDeck = quick ? quickPool : deck;
    if (!quick && deferCurrentPick && currentPick && fullPool.some((entry) => entry.game.id === currentPick.id)) {
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
    const nextPick = quick
      ? drawQuickVaultGame(availablePool, currentPick?.id)
      : drawVaultGame(availablePool, currentPick?.id);
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
      if (activeDraw !== activeDrawRef.current) return;
      setDrawState("revealing");
      await wait(reducedMotion ? 100 : 370);
      if (activeDraw !== activeDrawRef.current) return;

      const draw = await recordVaultDraw(nextPick.id, {
        steamAppId: nextPick.steamAppId,
        session: quick ? null : activeSession, mood: quick ? null : activeMood, goal: quick ? null : activeGoal,
        collectionId: quick ? null : activeCollectionId,
        selectedGenres: quick ? EMPTY_GAME_IDS : activeGenres,
        eligiblePoolCount: quick ? quickPool.length : fullPool.length,
        rerollIndex: drawnCycleRef.current.size - 1
      });
      if (activeDraw !== activeDrawRef.current) return;
      setCurrentDrawId(draw.id);
      setHighlightedGameId(nextPick.id);
      setDrawState("revealed");
      setDrawMessage(`Vault opened. ${nextPick.title} selected.`);
      trackEvent(ANALYTICS_EVENTS.vaultDrawRequested, {
        draw_mode: quick ? "quick" : collectionMode ? "collection" : "vault",
        session: quick ? null : activeSession,
        mood: quick ? null : activeMood,
        goal: quick ? null : activeGoal,
        collection_selected: quick ? false : Boolean(activeCollectionId),
        genre_count: quick ? 0 : activeGenres.length,
        pool_size: quick ? quickPool.length : fullPool.length,
        deck_size: activeDeck.length,
        reroll_index: drawnCycleRef.current.size - 1,
      });
      requestAnimationFrame(() => revealResultIfNeeded(resultRef.current, reducedMotion));
      queueGuestSignInPrompt();
    } catch (error) {
      if (activeDraw !== activeDrawRef.current) return;
      console.error("Vault draw failed", error);
      // A draw that never records is invisible in analytics unless it says so:
      // Quick Draw shipped broken precisely because only successes reported.
      trackEvent(ANALYTICS_EVENTS.vaultDrawFailed, {
        draw_mode: quick ? "quick" : collectionMode ? "collection" : "vault",
        reason: error instanceof Error ? error.message : "unknown"
      });
      drawnCycleRef.current.delete(nextPick.id);
      setDrawState("error");
      setDrawMessage("The Vault could not complete the draw. Please try again.");
    } finally {
      if (activeDraw === activeDrawRef.current) drawingRef.current = false;
    }
  }

  function toggleGenre(genre: string) {
    if (collectionMode) return;
    setSelectedGenres((current) => {
      if (current.includes(genre)) return current.filter((item) => item !== genre);
      if (current.length >= MAX_VAULT_GENRES) return current;
      return [...current, genre];
    });
  }

  function revealSetupStep(step: VaultSetupStep) {
    window.requestAnimationFrame(() => {
      const element = document.getElementById(`vault-setup-${step}`);
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      if (bounds.top < 96 || bounds.bottom > window.innerHeight - 96) {
        element.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
      }
      element.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    });
  }

  function focusSetupStep(step: VaultSetupStep) {
    setDrawMode("vault");
    setOpenSetupStep(step);
    revealSetupStep(step);
  }

  function selectSetupOption(step: VaultSetupStep, id: string) {
    setDrawMode("vault");
    // The configure step of the funnel: which of the three inputs people actually
    // fill in, and where they drop out before ever reaching a draw.
    trackEvent(ANALYTICS_EVENTS.vaultSetupChanged, { step, value: id });
    let nextStep: VaultSetupStep | null = null;

    if (step === "session") {
      setSession(id as VaultSessionId);
      nextStep = !mood ? "mood" : !goal ? "goal" : null;
    } else if (step === "mood") {
      setMood(id as VaultMoodId);
      nextStep = !session ? "session" : !goal ? "goal" : null;
    } else {
      setGoal(id as VaultGoalId);
      nextStep = !session ? "session" : !mood ? "mood" : null;
    }

    setOpenSetupStep(nextStep ?? step);
    if (nextStep) revealSetupStep(nextStep);
  }

  function activateCollectionDraw() {
    if (!isLive) {
      setGuestSignInOpen(true);
      return;
    }
    setDrawMode("collection");
  }

  function selectDrawCollection(id: string) {
    if (id === "all") {
      setDrawMode("vault");
      return;
    }
    setSelectedCollectionId(id);
    setSelectedGenres([]);
    setDrawMode("collection");
  }

  function handlePrimaryDrawAction() {
    if (canDraw) {
      void handleOpenVault();
      return;
    }
    if (collectionMode) {
      document.getElementById("vault-collection-picker-trigger")?.click();
      return;
    }
    if (nextSetupStep) focusSetupStep(nextSetupStep);
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

      {!isLive ? <aside className={styles.guestPreviewBanner} aria-label="Guest preview">
        <span className={styles.guestPreviewIcon}><VaultIcon name="current-pick" size={24} /></span>
        <span className={styles.guestPreviewCopy}><strong>Guest preview · {ownedGames.length} popular Steam games</strong><small>Try the Vault with live catalogue data, then connect Steam to shuffle your own library and save your picks.</small></span>
        <a href="/api/auth/steam" onClick={() => trackNavigationEvent(ANALYTICS_EVENTS.signInStarted, { location: "vault_banner" })}><VaultIcon name="open-steam" size={18} />Shuffle my library<VaultIcon name="chevron-right" size={16} /></a>
      </aside> : null}

      <section className={styles.setupLayout} aria-labelledby="vault-setup-title" data-paused={collectionMode || undefined}>
        <header className={styles.setupGuide}>
          <div className={styles.setupGuideCopy}>
            <h2 id="vault-setup-title">Build your Vault Draw</h2>
            <p>{collectionMode ? "Collection Draw is active. Choose any step to switch back." : "Make three quick choices, then we’ll pick your game."}</p>
          </div>
          <strong className={styles.setupCount}>{collectionMode ? "Paused" : `${setupReadyCount} of 3 ready`}</strong>
          <div className={styles.setupProgress} aria-label={`${setupReadyCount} of 3 required choices complete`}>
            {setupSteps.map((step, index) => {
              const complete = Boolean(step.value);
              const active = step.id === openSetupStep;
              return <button key={step.id} type="button" className={styles.progressStep} data-state={complete ? "complete" : active ? "active" : "pending"} onClick={() => focusSetupStep(step.id)}>
                <span className={styles.progressNumber} aria-hidden="true">{complete ? <VaultIcon name="check" size={15} /> : index + 1}</span>
                <span><strong>{step.label}</strong><small>{step.value ?? (active ? "Choose now" : "Required")}</small></span>
              </button>;
            })}
          </div>
        </header>

        <div className={styles.optionStack}>
          <VaultOptionGroup title="Session" stepNumber={1} options={vaultSessionOptions} selectedId={session} selectedLabel={sessionLabel} expanded={openSetupStep === "session"} state={session ? "complete" : openSetupStep === "session" ? "active" : "pending"} onToggle={() => focusSetupStep("session")} onSelect={(id) => selectSetupOption("session", id)} />
          <VaultOptionGroup title="Mood" stepNumber={2} options={vaultMoodOptions} selectedId={mood} selectedLabel={moodLabel} expanded={openSetupStep === "mood"} state={mood ? "complete" : openSetupStep === "mood" ? "active" : "pending"} onToggle={() => focusSetupStep("mood")} onSelect={(id) => selectSetupOption("mood", id)} />
          <VaultOptionGroup title="Goal" stepNumber={3} options={vaultGoalOptions} selectedId={goal} selectedLabel={goalLabel} expanded={openSetupStep === "goal"} state={goal ? "complete" : openSetupStep === "goal" ? "active" : "pending"} onToggle={() => focusSetupStep("goal")} onSelect={(id) => selectSetupOption("goal", id)} lockedOptionIds={isLive ? [] : ["finish"]} onLockedSelect={() => setGuestSignInOpen(true)} />
        </div>

        <div className={styles.setupSidebar}>
          <aside className={styles.optionalSetup} aria-label="Optional genre filters" data-disabled={collectionMode || undefined}>
            <div className={styles.optionalHeader}>
              <span className={styles.optionalIcon}><VaultIcon name="filter" size={21} /></span>
              <span className={styles.optionalCopy}><strong>Genre filters</strong><small>{collectionMode ? "Vault Draw only · collection mode ignores filters" : selectedGenres.length ? `${selectedGenres.length} of 3 selected` : "Optional · no filters selected"}</small></span>
              <span className={styles.optionalLabel}>{collectionMode ? "Paused" : "Optional"}</span>
            </div>
            <div className={styles.optionalContent}>
              <div className={styles.genreSetup}>
                <VaultGenrePanel selectedGenres={selectedGenres} onToggleGenre={toggleGenre} onClear={clearGenres} embedded disabled={collectionMode} />
              </div>
            </div>
          </aside>
        </div>
      </section>

      <section className={styles.drawActionBar} aria-label="Vault draw status" data-mode={drawMode}>
        <div className={styles.drawModePicker}>
          <div className={styles.drawModeToggle} role="tablist" aria-label="Draw type">
            <button type="button" role="tab" aria-selected={!collectionMode} className={styles.drawModeButton} data-active={!collectionMode || undefined} onClick={() => setDrawMode("vault")}><VaultIcon name="draw-from-vault" size={17} />Vault Draw</button>
            <button type="button" role="tab" aria-selected={collectionMode} className={styles.drawModeButton} data-active={collectionMode || undefined} onClick={activateCollectionDraw}><VaultIcon name="collections" size={17} />Collection Draw</button>
          </div>
          <div className={styles.drawModeOptions}>
            <div className={styles.drawActionSummary} data-paused={collectionMode || undefined}>
              <span className={styles.drawSummaryHeading}><strong>{nextSetupStep ? `Step ${setupReadyCount + 1} of 3` : "Vault Draw ready"}</strong><small>{collectionMode ? "Saved while Collection Draw is active" : "Session, mood and goal"}</small></span>
              <div className={styles.drawChoiceRow}>
                {setupSteps.map((step) => <button key={step.id} type="button" className={styles.drawChoice} data-complete={Boolean(step.value) || undefined} onClick={() => focusSetupStep(step.id)}><VaultIcon name={step.value ? "check" : step.id === "session" ? "session" : step.id === "mood" ? "mood" : "goal"} size={14} />{step.value ?? step.label}</button>)}
              </div>
            </div>
            <span className={styles.drawModeOr} aria-hidden="true">or</span>
            <div className={styles.drawCollectionChoice} data-active={collectionMode || undefined}>
              <VaultCollectionCard
                triggerId="vault-collection-picker-trigger"
                selectedCollection={selectedCollection ?? entireVault}
                collections={collections}
                collectionCounts={collectionCounts}
                onSelect={selectDrawCollection}
                guestLocked={!isLive}
                onGuestLocked={() => setGuestSignInOpen(true)}
                selectionActive={collectionDraw}
                allowEntireVault={false}
              />
            </div>
          </div>
        </div>
        <div className={styles.drawActionControl}>
          <button type="button" className={styles.ctaButton} onClick={handlePrimaryDrawAction} disabled={drawingRef.current || (collectionMode ? Boolean(selectedCollection && !deck.length) : (!nextSetupStep && !deck.length))} aria-busy={drawingRef.current} aria-describedby="vault-setup-status">
            <VaultIcon name="draw-from-vault" size={22} />{drawButtonLabel}
          </button>
          <button type="button" className={styles.quickDrawButton} onClick={() => void handleOpenVault({ quick: true })} disabled={drawingRef.current || !quickPool.length}>
            <VaultIcon name="draw-again" size={17} />Just pick something
          </button>
          <p className={styles.setupStatus} id="vault-setup-status">{setupStatusMessage}</p>
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
                aria-expanded={isLive ? historyOpen : false}
                aria-haspopup="dialog"
                onClick={() => {
                  if (!isLive) {
                    setGuestSignInOpen(true);
                    return;
                  }
                  setHistoryOpen(true);
                  void loadVaultHistory();
                }}
              >
                <span className={styles.deckToolIcon}><VaultIcon name="clock" size={21} /></span>
                <span className={styles.deckToolCopy}><strong>Draw History</strong><small>{isLive ? "Revisit previous picks" : "Sign in to save draws"}</small></span>
                <VaultIcon className={styles.deckToolArrow} name="chevron-right" size={17} />
              </button>
            </div>
          </div>

          {lensOpen ? <VaultLens stages={eligibility.stages} selectedCollection={collectionDraw} selectedGenres={Boolean(activeGenres.length)} snoozedCount={snoozedIds.size} onClearGenres={clearGenres} onUseEntireVault={() => setDrawMode("vault")} onClearSnoozes={() => void clearSnoozes()} /> : null}

          <div className={styles.pillRow}>
            {collectionDraw && selectedCollection ? <FilterPill label={`Collection · ${selectedCollection.name}`} /> : null}
            {!collectionMode && session ? <FilterPill label={vaultSessionOptions.find((option) => option.id === session)?.label ?? "Session"} /> : null}
            {!collectionMode && mood ? <FilterPill label={vaultMoodOptions.find((option) => option.id === mood)?.label ?? "Mood"} /> : null}
            {!collectionMode && goal ? <FilterPill label={vaultGoalOptions.find((option) => option.id === goal)?.label ?? "Goal"} /> : null}
            {!collectionMode ? selectedGenres.map((genre) => <FilterPill key={genre} label={genre} removable onRemove={() => toggleGenre(genre)} />) : null}
            {!collectionMode && !session && !mood && !goal && !selectedGenres.length ? <span className={styles.noFilters}>No filters selected</span> : null}
            {collectionMode && !selectedCollection ? <span className={styles.noFilters}>Choose a collection to build this deck.</span> : null}
          </div>
        </div>

        {deck.length ? (
          <VaultPoolPreview
            entries={deck}
            drawState={drawState}
            winner={ownedGames.find((game) => game.id === drawWinnerId) ?? null}
            highlightedId={highlightedGameId}
            onSelect={isLive ? setDetailsGameId : () => setGuestSignInOpen(true)}
            sleepingId={sleepingGameId}
            onSleep={(id) => void sleepPoolGame(id)}
            pinnedIds={vaultState.pinnedIds}
            onPin={(id) => void togglePin(id)}
            onComplete={(id) => {
              const game = ownedGames.find((item) => item.id === id);
              if (game) void completeGame(game);
            }}
            onUserScroll={() => setHighlightedGameId(null)}
            allowActions={isLive}
          />
        ) : (
          <div className={styles.emptyState}>
            <h3 className={styles.emptyTitle}>{collectionMode ? selectedCollection ? "No active games in this collection." : "Choose a collection to build this deck." : "No games matched that combination."}</h3>
            <p className={styles.emptyCopy}>{collectionMode ? selectedCollection ? "Try another collection or switch back to Vault Draw." : "Collection Draw uses every active game in the collection, without extra filters." : "Try loosening the genre filters or switch to Surprise Me for a wider pool."}</p>
            {collectionMode ? <button type="button" className={styles.secondaryAction} onClick={() => setDrawMode("vault")}>Use Vault Draw</button> : <button type="button" className={styles.secondaryAction} onClick={clearGenres}>Clear genre filters</button>}
          </div>
        )}

      </section>

      <p className="visually-hidden" aria-live="polite">{drawMessage}</p>

      {currentPick ? (
        <section ref={resultRef} className={`${styles.resultCard} ${drawState === "revealed" ? styles.resultRevealed : ""}`} data-visible={drawState === "revealed"}>
          <div className={styles.resultArtwork}>
            <Artwork src={currentPick.bannerUrl} sizes="(max-width: 820px) 100vw, 42vw" priority fit="contain" />
            <span className={styles.currentPickBadge}><VaultIcon name="current-pick" size={18} />Current pick</span>
          </div>
          <div className={styles.resultBody}>
            <div className={styles.resultHeading}><h2 className={styles.resultTitle}>{currentPick.title}</h2><VaultIcon name="new" size={22} /></div>
            <p className={styles.resultCopy}>{currentPick.description}</p>
            <p className={styles.reasonLabel}>Why it&apos;s a great match</p>
            <div className={styles.resultReasonRow}>
              {(fullPool.find((entry) => entry.game.id === currentPick.id)?.reasons ?? []).map((reason) => <FilterPill key={reason} label={reason} />)}
            </div>
            <p className={styles.actionsLabel}>{isLive ? "Vault actions" : "Preview actions"}</p>
            <div className={`${styles.resultActions}${!isLive ? ` ${styles.guestResultActions}` : ""}`}>
              <a href={isLive ? steamLaunchUrl(currentPick.steamAppId) : steamStoreUrl(currentPick.steamAppId)} target={isLive ? undefined : "_blank"} rel={isLive ? undefined : "noreferrer"} className={`${styles.resultAction} ${styles.resultActionPrimary}`} onClick={() => currentDrawId ? void recordDrawEvent(currentDrawId, "opened_on_steam") : undefined}>
                <VaultResultActionIcon name="open-steam" /><span className={styles.resultActionCopy}><strong>{isLive ? "Open on Steam" : "View on Steam"}</strong><small>{isLive ? "Launch the game" : "Open the store page"}</small></span>
              </a>
              {isLive ? <>
              <button type="button" className={styles.resultAction} onClick={() => { void togglePin(currentPick.id); if (currentDrawId) void recordDrawEvent(currentDrawId, vaultState.pinnedIds.includes(currentPick.id) ? "unpinned" : "pinned"); }}>
                <VaultResultActionIcon name="pin" /><span className={styles.resultActionCopy}><strong>{vaultState.pinnedIds.includes(currentPick.id) ? `Pinned · ${vaultState.pinnedIds.length}/3` : vaultState.pinnedIds.length >= 3 ? "Pins Full · 3/3" : `Pin This Pick · ${vaultState.pinnedIds.length}/3`}</strong><small>Pinned Library shelf</small></span>
              </button>
              </> : null}
              <button type="button" className={styles.resultAction} onClick={() => { if (currentDrawId) void recordDrawEvent(currentDrawId, "drew_again"); void handleOpenVault({ deferCurrentPick: true }); }}>
                <VaultResultActionIcon name="draw-again" /><span className={styles.resultActionCopy}><strong>Draw Again</strong><small>Find something else</small></span>
              </button>
              {isLive ? <><button type="button" className={styles.resultAction} onClick={() => { if (currentDrawId) void recordDrawEvent(currentDrawId, "hidden_for_session"); void snoozeCurrentPick(); }}>
                <VaultResultActionIcon name="snooze-not-now" /><span className={styles.resultActionCopy}><strong>Not Now</strong><small>Snooze this pick</small></span>
              </button>
              <button type="button" className={styles.resultAction} onClick={() => setDetailsGameId(currentPick.id)}>
                <VaultResultActionIcon name="view-details" /><span className={styles.resultActionCopy}><strong>View Details</strong><small>See progress, notes and collections</small></span>
              </button>
              <button type="button" className={styles.resultAction} onClick={() => { if (currentDrawId) void recordDrawEvent(currentDrawId, "marked_completed"); void completeGame(currentPick); }}>
                <VaultResultActionIcon name="mark-completed" /><span className={styles.resultActionCopy}><strong>Mark as Completed</strong><small>Archive this game</small></span>
              </button></> : <a href="/api/auth/steam" className={styles.resultAction} onClick={() => trackNavigationEvent(ANALYTICS_EVENTS.signInStarted, { location: "vault_result" })}>
                <VaultResultActionIcon name="all-games" /><span className={styles.resultActionCopy}><strong>Shuffle My Library</strong><small>Connect Steam for personal draws</small></span>
              </a>}
            </div>
          </div>
          <aside className={styles.resultContext} aria-label="Selected setup">
            {collectionDraw ? <>
              <ResultSummary icon="collections" label="Collection Draw" value={selectedCollection?.name ?? "Collection"} />
              <ResultSummary icon="genre" label="Filters" value="Collection only" />
            </> : <>
              <ResultSummary icon="clock" label="Session" value={vaultSessionOptions.find((option) => option.id === session)?.label ?? "Not selected"} />
              <ResultSummary icon="mood" label="Mood" value={vaultMoodOptions.find((option) => option.id === mood)?.label ?? "Not selected"} />
              <ResultSummary icon="goal" label="Goal" value={vaultGoalOptions.find((option) => option.id === goal)?.label ?? "Not selected"} />
              <ResultSummary icon="genre" label="Genres / context" value={selectedGenres.length ? selectedGenres.join(" · ") : (isLive ? "Entire Vault" : "Guest Catalogue")} />
            </>}
            {formatGameDuration(currentPick.duration) ? <ResultSummary icon="clock" label="Estimated playthrough" value={formatGameDuration(currentPick.duration)!} /> : null}
          </aside>
        </section>
      ) : null}

      {isLive ? <LibraryDetailsDrawer
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
        onSleep={() => detailsGame ? sleepPoolGame(detailsGame.id) : Promise.resolve()}
        onRestore={() => detailsGame ? restoreGame(detailsGame.id) : Promise.resolve()}
      /> : null}
      {isLive ? <VaultHistoryDrawer
        open={historyOpen}
        draws={vaultHistory}
        games={ownedGames}
        onClose={() => setHistoryOpen(false)}
        onClear={clearVaultHistory}
        onViewDetails={(game) => {
          setHistoryOpen(false);
          setDetailsGameId(game.id);
        }}
      /> : null}
      <GuestSignInPrompt open={guestSignInOpen} onClose={closeGuestSignInPrompt} catalogueSize={ownedGames.length} />
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

function ResultSummary({ icon, label, value }: { icon: "clock" | "mood" | "goal" | "genre" | "collections"; label: string; value: string }) {
  return <div className={styles.summaryItem}><VaultIcon name={icon} size={23} /><span><small>{label}</small><strong>{value}</strong></span></div>;
}

type VaultResultActionIconName = "open-steam" | "pin" | "draw-again" | "snooze-not-now" | "view-details" | "mark-completed" | "all-games";

function VaultResultActionIcon({ name }: { name: VaultResultActionIconName }) {
  return <span className={styles.resultActionIcon} aria-hidden="true"><VaultIcon name={name} size={48} /></span>;
}
