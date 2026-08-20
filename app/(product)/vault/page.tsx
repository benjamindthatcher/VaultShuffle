"use client";

import { VAULT_REROLL_REASONS } from "@/lib/vault-history";
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
import { SectionHeading } from "@/components/shared/SectionHeading";
import { VaultOptionGroup } from "@/components/vault/VaultOptionGroup";
import { VaultMatchReasons } from "@/components/vault/VaultMatchReasons";
import { PinnedCommitments } from "@/components/shared/PinnedCommitments";
import { WelcomeBack } from "@/components/shared/WelcomeBack";
import { useGenreLearning, type GenreLearningArm } from "@/components/vault/useGenreLearning";
import { VaultPoolPreview } from "@/components/vault/VaultPoolPreview";
import { type DemoGame, type VaultGoalId, type VaultMoodId, type VaultSessionId } from "@/lib/demo-data";
import {
  buildVaultDeck,
  buildVaultPool,
  buildVaultMatchExplanation,
  vaultFinalists,
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
import { trackCompletionClaim, trackCompletionUndone } from "@/lib/completion-tracking";
import styles from "./vault.module.css";

type VaultDrawState = "idle" | "focusing" | "revealing" | "revealed" | "error";
type VaultSetupStep = "session" | "mood" | "goal";
type VaultDrawMode = "vault" | "collection";
type DeferredDeckQueue = { setupKey: string; gameIds: string[] };
const EMPTY_GAME_IDS: string[] = [];
const GUEST_SIGN_IN_PROMPT_KEY = "vaultshuffle:guest-first-draw-prompt:v1";

export default function VaultPage() {
  const { games, collections, vaultState, genrePreferences: learnedGenrePreferences, genrePreferenceGlobals: learnedGenreGlobals, vaultHistory, isLive, recordVaultAction, recordVaultDraw, loadVaultHistory, recordDrawEvent, clearVaultHistory, updateGame, restoreGame, setGameCollection } = useAppData();
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
  // What the rail focuses on, set when the draw starts so the animation knows
  // where it is heading.
  const [drawWinnerId, setDrawWinnerId] = useState<string | null>(null);
  // What the result card shows, set only once the reveal lands. These used to be
  // the same value, so the card named the game at the moment the draw started —
  // the answer arrived a full animation before the animation that announces it.
  const [revealedPickId, setRevealedPickId] = useState<string | null>(null);
  const [drawMessage, setDrawMessage] = useState("");
  const [lensOpen, setLensOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [currentDrawId, setCurrentDrawId] = useState<string | null>(null);
  const [guestSignInOpen, setGuestSignInOpen] = useState(false);
  const guestDrawCountRef = useRef(0);
  const [lastDrawWasQuick, setLastDrawWasQuick] = useState(false);
  const [rerollCount, setRerollCount] = useState(0);
  const [drawArm, setDrawArm] = useState<GenreLearningArm>("control");
  const drawRerollIndexRef = useRef(0);
  const [feedbackGiven, setFeedbackGiven] = useState<"liked" | "disliked" | null>(null);
  const [rerollReasonGiven, setRerollReasonGiven] = useState(false);
  const drawingRef = useRef(false);
  const resultRef = useRef<HTMLElement>(null);
  const drawnCycleRef = useRef<Set<string>>(new Set());
  const activeDrawRef = useRef(0);
  const deferredQueueRef = useRef<DeferredDeckQueue>({ setupKey: "", gameIds: [] });
  const guestPromptQueuedRef = useRef(false);
  const guestPromptTimerRef = useRef<number | null>(null);
  const [deferredQueue, setDeferredQueue] = useState<DeferredDeckQueue>({ setupKey: "", gameIds: [] });

  const { genrePreferences, genrePreferenceGlobals, preferenceRowCount, nextArm } = useGenreLearning(learnedGenrePreferences, learnedGenreGlobals);
  // Attached to every follow-up event so the outcome can be attributed to the arm
  // that produced the draw, and so rerolls-to-launch is readable straight off
  // vault_pick_launched.
  const drawEventAnalytics = useCallback(
    () => ({ vault_genre_learning: drawArm, reroll_index: drawRerollIndexRef.current }),
    [drawArm]
  );
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
        snoozedIds,
        genrePreferences,
        genrePreferenceGlobals
      });
    },
    [activeCollectionId, activeGenres, activeGoal, activeMood, activeSession, drawMode, genrePreferences, genrePreferenceGlobals, ownedGames, snoozedIds]
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
  // Memoised because VaultPoolPreview scrolls the rail to the winner in an effect
  // keyed on it. Found fresh each render, the effect re-ran on every state change
  // during the draw and restarted the smooth scroll each time.
  const drawWinner = useMemo(
    () => ownedGames.find((game) => game.id === drawWinnerId) ?? null,
    [ownedGames, drawWinnerId]
  );
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
    game.id === revealedPickId &&
    game.status !== "Completed" &&
    game.status !== "Slept" &&
    !snoozedIds.has(game.id)
  ) ?? null;
  // Explained against the pool the pick actually came from, and only for the
  // inputs that actually shaped it: a Quick Draw ignores the setup entirely and a
  // Collection Draw drops session, mood and goal, so claiming credit for them
  // would be inventing reasoning the draw never used.
  const currentPickExplanation = useMemo(() => {
    if (!currentPick) return null;
    const pool = lastDrawWasQuick ? quickPool : fullPool;
    const entry = pool.find((candidate) => candidate.game.id === currentPick.id);
    if (!entry) return null;

    const guided = !lastDrawWasQuick && !collectionMode;
    return buildVaultMatchExplanation({
      entry,
      pool,
      session: guided ? activeSession : null,
      mood: guided ? activeMood : null,
      goal: guided ? activeGoal : null,
      selectedGenres: guided ? activeGenres : []
    });
  }, [activeGenres, activeGoal, activeMood, activeSession, collectionMode, currentPick, fullPool, lastDrawWasQuick, quickPool]);

  const detailsGame = ownedGames.find((game) => game.id === detailsGameId) ?? null;
  const canDraw = collectionMode
    ? Boolean(collectionDraw && deck.length > 0)
    : Boolean(session && mood && goal && deck.length > 0);
  const sessionLabel = vaultSessionOptions.find((option) => option.id === session)?.label ?? null;
  const moodLabel = vaultMoodOptions.find((option) => option.id === mood)?.label ?? null;
  const goalLabel = vaultGoalOptions.find((option) => option.id === goal)?.label ?? null;
  const nextSetupStep: VaultSetupStep | null = !session ? "session" : !mood ? "mood" : !goal ? "goal" : null;
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

  // The scroll to the result runs here rather than inside the draw, because the
  // card now mounts with the reveal: measured from the draw's own tick there was
  // nothing in the DOM to measure yet.
  useEffect(() => {
    if (drawState !== "revealed" || !revealedPickId) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frame = requestAnimationFrame(() => revealResultIfNeeded(resultRef.current, reducedMotion));
    return () => cancelAnimationFrame(frame);
  }, [drawState, revealedPickId]);

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
    setLastDrawWasQuick(quick);
    setFeedbackGiven(null);
    if (deferCurrentPick) setRerollCount((count) => count + 1);
    else { setRerollCount(0); setRerollReasonGiven(false); }
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
    // Quick Draw is uniform by design and takes no part in the experiment.
    const arm = quick ? "control" : nextArm();
    const nextPick = quick
      ? drawQuickVaultGame(availablePool, currentPick?.id)
      : drawVaultGame(availablePool, currentPick?.id, Math.random, arm === "test");
    if (!nextPick) return;
    setDrawArm(arm);
    drawnCycleRef.current.add(nextPick.id);

    drawingRef.current = true;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setDrawWinnerId(nextPick.id);
    setHighlightedGameId(null);
    setDrawMessage("Opening the Vault.");
    setDrawState("focusing");

    // The pick is already decided, so the write does not have to finish before we
    // can show it. Started here, its latency runs underneath the animation rather
    // than after it — the draw used to sit frozen on the last frame for as long as
    // the round trip took. Settled either way so a rejection is never unhandled.
    const record = recordVaultDraw(nextPick.id, {
      steamAppId: nextPick.steamAppId,
      session: quick ? null : activeSession, mood: quick ? null : activeMood, goal: quick ? null : activeGoal,
      collectionId: quick ? null : activeCollectionId,
      selectedGenres: quick ? EMPTY_GAME_IDS : activeGenres,
      eligiblePoolCount: quick ? quickPool.length : fullPool.length,
      rerollIndex: drawnCycleRef.current.size - 1,
      // Recorded even in the control arm: the choice set is training data for a
      // future model, not part of this experiment.
      finalistAppIds: quick ? undefined : vaultFinalists(availablePool, currentPick?.id).map((entry) => entry.game.steamAppId).filter((appId): appId is number => typeof appId === "number" && appId > 0)
    }).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    );

    try {
      await wait(reducedMotion ? 80 : 480);
      if (activeDraw !== activeDrawRef.current) return;
      setDrawState("revealing");
      await wait(reducedMotion ? 100 : 370);
      if (activeDraw !== activeDrawRef.current) return;

      const outcome = await record;
      if (activeDraw !== activeDrawRef.current) return;
      if (!outcome.ok) throw outcome.error;
      const draw = outcome.value;
      drawRerollIndexRef.current = drawnCycleRef.current.size - 1;
      setCurrentDrawId(draw.id);
      setHighlightedGameId(nextPick.id);
      setRevealedPickId(nextPick.id);
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
        vault_genre_learning: arm,
        preference_rows: preferenceRowCount,
      });
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
    trackCompletionClaim(game, "vault", isLive);
    setHighlightedGameId(null);
    setCompletionUndo({ id: game.id, title: game.title });
  }

  async function undoCompletion() {
    if (!completionUndo) return;
    const gameId = completionUndo.id;
    const game = ownedGames.find((entry) => entry.id === gameId);
    setCompletionUndo(null);
    await restoreGame(gameId);
    if (game) trackCompletionUndone(game, "vault", isLive);
  }

  return (
    <section className={styles.vaultPage}>
      <h1 className="visually-hidden">Vault</h1>

      {isLive ? (
        <PinnedCommitments
          games={ownedGames}
          pins={vaultState.pins ?? []}
          pinnedIds={vaultState.pinnedIds}
          onSelect={(gameId) => setDetailsGameId(gameId)}
          onUnpin={(gameId) => void recordVaultAction("unpinned", gameId)}
          compact
        />
      ) : null}

      <WelcomeBack />

      {!isLive ? <aside className={styles.guestPreviewBanner} aria-label="Guest preview">
        <span className={styles.guestPreviewIcon}><VaultIcon name="current-pick" size={24} /></span>
        <span className={styles.guestPreviewCopy}><strong>Guest preview · {ownedGames.length} popular Steam games</strong><small>Try the Vault with live catalogue data, then connect Steam to shuffle your own library and save your picks.</small></span>
        <a href="/api/auth/steam" onClick={() => trackNavigationEvent(ANALYTICS_EVENTS.signInStarted, { location: "vault_banner" })}><VaultIcon name="open-steam" size={18} />Shuffle my library<VaultIcon name="chevron-right" size={16} /></a>
      </aside> : null}

      <section className={styles.setupLayout} aria-label="Vault draw setup" data-paused={collectionMode || undefined}>
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
          <p className={styles.setupStatus} id="vault-setup-status">{setupStatusMessage}</p>
          <button type="button" className={styles.quickDrawButton} onClick={() => void handleOpenVault({ quick: true })} disabled={drawingRef.current || !quickPool.length}>
            <VaultIcon name="surprise-me" size={16} />Skip it, just pick something
          </button>
        </div>
      </section>

      <section className={styles.poolSection} id="vault-pool">
        <div className={styles.poolControls}>
          <SectionHeading
            title="Vault deck"
            meta={`${deck.length}${fullPool.length > deck.length ? ` of ${fullPool.length}` : ""} matches`}
            action={<div className={styles.deckTools}>
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
            </div>}
          />

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
            winner={drawWinner}
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
            {currentPickExplanation ? <VaultMatchReasons explanation={currentPickExplanation} /> : (
              <>
                <p className={styles.reasonLabel}>Why it&apos;s a great match</p>
                <div className={styles.resultReasonRow}>
                  {(fullPool.find((entry) => entry.game.id === currentPick.id)?.reasons ?? []).map((reason) => <FilterPill key={reason} label={reason} />)}
                </div>
              </>
            )}
            {isLive && currentDrawId ? <div className={styles.feedbackRow}>
              <span className={styles.feedbackLabel}>Good pick?</span>
              <button
                type="button"
                className={feedbackGiven === "liked" ? styles.feedbackOn : styles.feedbackButton}
                aria-pressed={feedbackGiven === "liked"}
                disabled={Boolean(feedbackGiven)}
                onClick={() => { setFeedbackGiven("liked"); void recordDrawEvent(currentDrawId, "liked", drawEventAnalytics()); }}
              >Yes</button>
              <button
                type="button"
                className={feedbackGiven === "disliked" ? styles.feedbackOn : styles.feedbackButton}
                aria-pressed={feedbackGiven === "disliked"}
                disabled={Boolean(feedbackGiven)}
                onClick={() => { setFeedbackGiven("disliked"); void recordDrawEvent(currentDrawId, "disliked", drawEventAnalytics()); }}
              >Not really</button>
              {feedbackGiven ? <span className={styles.feedbackThanks}>Noted.</span> : null}
            </div> : null}

            {isLive && currentDrawId && rerollCount >= 3 && !rerollReasonGiven ? <div className={styles.rerollAsk}>
              <span className={styles.feedbackLabel}>Nothing landing. What&apos;s off?</span>
              <div className={styles.rerollReasons}>
                {VAULT_REROLL_REASONS.map((reason) => (
                  <button
                    key={reason.id}
                    type="button"
                    className={styles.feedbackButton}
                    onClick={() => { setRerollReasonGiven(true); void recordDrawEvent(currentDrawId, reason.id, drawEventAnalytics()); }}
                  >{reason.label}</button>
                ))}
              </div>
            </div> : null}

            <p className={styles.actionsLabel}>{isLive ? "Vault actions" : "Preview actions"}</p>
            <div className={`${styles.resultActions}${!isLive ? ` ${styles.guestResultActions}` : ""}`}>
              <a href={isLive ? steamLaunchUrl(currentPick.steamAppId) : steamStoreUrl(currentPick.steamAppId)} target={isLive ? undefined : "_blank"} rel={isLive ? undefined : "noreferrer"} className={`${styles.resultAction} ${styles.resultActionPrimary}`} onClick={() => currentDrawId ? void recordDrawEvent(currentDrawId, "opened_on_steam", drawEventAnalytics()) : undefined}>
                <VaultResultActionIcon name="open-steam" /><span className={styles.resultActionCopy}><strong>{isLive ? "Open on Steam" : "View on Steam"}</strong><small>{isLive ? "Launch the game" : "Open the store page"}</small></span>
              </a>
              {isLive ? <>
              <button type="button" className={styles.resultAction} onClick={() => { void togglePin(currentPick.id); if (currentDrawId) void recordDrawEvent(currentDrawId, vaultState.pinnedIds.includes(currentPick.id) ? "unpinned" : "pinned", drawEventAnalytics()); }}>
                <VaultResultActionIcon name="pin" /><span className={styles.resultActionCopy}><strong>{vaultState.pinnedIds.includes(currentPick.id) ? `Pinned · ${vaultState.pinnedIds.length}/3` : vaultState.pinnedIds.length >= 3 ? "Pins Full · 3/3" : `Pin This Pick · ${vaultState.pinnedIds.length}/3`}</strong><small>Pinned Library shelf</small></span>
              </button>
              </> : null}
              <button type="button" className={styles.resultAction} onClick={() => { if (currentDrawId) void recordDrawEvent(currentDrawId, "drew_again", drawEventAnalytics()); void handleOpenVault({ deferCurrentPick: true, quick: lastDrawWasQuick }); }}>
                <VaultResultActionIcon name="draw-again" /><span className={styles.resultActionCopy}><strong>Draw Again</strong><small>Find something else</small></span>
              </button>
              {isLive ? <><button type="button" className={styles.resultAction} onClick={() => { if (currentDrawId) void recordDrawEvent(currentDrawId, "hidden_for_session", drawEventAnalytics()); void snoozeCurrentPick(); }}>
                <VaultResultActionIcon name="snooze-not-now" /><span className={styles.resultActionCopy}><strong>Not Now</strong><small>Snooze this pick</small></span>
              </button>
              <button type="button" className={styles.resultAction} onClick={() => setDetailsGameId(currentPick.id)}>
                <VaultResultActionIcon name="view-details" /><span className={styles.resultActionCopy}><strong>View Details</strong><small>See progress, notes and collections</small></span>
              </button>
              <button type="button" className={styles.resultAction} onClick={() => { if (currentDrawId) void recordDrawEvent(currentDrawId, "marked_completed", drawEventAnalytics()); void completeGame(currentPick); }}>
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
  if (!isBelowViewport) return;
  // window.scrollTo rather than scrollIntoView: scrollIntoView walks every
  // scrollable ancestor, so it also nudged the deck rail sideways while the rail
  // was still running its own smooth scroll to the winner, and the two fought.
  window.scrollTo({
    top: window.scrollY + bounds.top - 24,
    behavior: reducedMotion ? "auto" : "smooth"
  });
}

function ResultSummary({ icon, label, value }: { icon: "clock" | "mood" | "goal" | "genre" | "collections"; label: string; value: string }) {
  return <div className={styles.summaryItem}><VaultIcon name={icon} size={23} /><span><small>{label}</small><strong>{value}</strong></span></div>;
}

type VaultResultActionIconName = "open-steam" | "pin" | "draw-again" | "snooze-not-now" | "view-details" | "mark-completed" | "all-games";

function VaultResultActionIcon({ name }: { name: VaultResultActionIconName }) {
  return <span className={styles.resultActionIcon} aria-hidden="true"><VaultIcon name={name} size={48} /></span>;
}
