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
import { GuestPreviewNotice } from "@/components/guest/GuestPreviewNotice";
import { SectionHeading } from "@/components/shared/SectionHeading";
import { VaultOptionGroup } from "@/components/vault/VaultOptionGroup";
import { VaultMatchReasons } from "@/components/vault/VaultMatchReasons";
import { PinnedCommitments } from "@/components/shared/PinnedCommitments";
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
import { matchesSmartPreset } from "@/lib/smart-collections";
import { ANALYTICS_EVENTS, trackEvent } from "@/lib/analytics";
import { trackCompletionClaim, trackCompletionUndone } from "@/lib/completion-tracking";
import styles from "./vault.module.css";

type VaultDrawState = "idle" | "focusing" | "revealing" | "revealed" | "error";
type VaultSetupStep = "session" | "mood" | "goal";
type VaultDrawMode = "vault" | "collection";
type DeferredDeckQueue = { setupKey: string; gameIds: string[] };
const EMPTY_GAME_IDS: string[] = [];

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

  // Confirmations are news for a moment and clutter after that. It had a
  // Dismiss button and nothing else, so it sat there until you told it to go.
  useEffect(() => {
    if (!pinMessage) return;
    const timer = window.setTimeout(() => setPinMessage(""), 4000);
    return () => window.clearTimeout(timer);
  }, [pinMessage]);
  const [completionUndo, setCompletionUndo] = useState<{ id: string; title: string } | null>(null);
  const [drawState, setDrawState] = useState<VaultDrawState>("idle");
  const [genresOpen, setGenresOpen] = useState(false);
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
  const [lastDrawWasQuick, setLastDrawWasQuick] = useState(false);
  const [rerollCount, setRerollCount] = useState(0);
  const [drawArm, setDrawArm] = useState<GenreLearningArm>("control");
  const drawRerollIndexRef = useRef(0);
  const [feedbackGiven, setFeedbackGiven] = useState<"liked" | "disliked" | null>(null);
  const [rerollReasonGiven, setRerollReasonGiven] = useState(false);
  const drawingRef = useRef(false);
  const drawStageRef = useRef<HTMLElement>(null);
  const resultRef = useRef<HTMLElement>(null);
  const drawnCycleRef = useRef<Set<string>>(new Set());
  const activeDrawRef = useRef(0);
  const deferredQueueRef = useRef<DeferredDeckQueue>({ setupKey: "", gameIds: [] });
  const [deferredQueue, setDeferredQueue] = useState<DeferredDeckQueue>({ setupKey: "", gameIds: [] });

  const { genrePreferences, genrePreferenceGlobals, preferenceRowCount, nextArm } = useGenreLearning(learnedGenrePreferences, learnedGenreGlobals);
  // Attached to every follow-up event so the outcome can be attributed to the arm
  // that produced the draw, and so rerolls-to-launch is readable straight off
  // vault_pick_launched.
  const drawEventAnalytics = useCallback(
    () => ({
      vault_genre_learning: drawArm,
      reroll_index: drawRerollIndexRef.current,
      preview_mode: !isLive,
    }),
    [drawArm, isLive]
  );
  const ownedGames = useMemo(() => games
    .filter((game) => game.ownership === "Owned")
    .map((game) => ({
      ...game,
      collectionIds: Array.from(new Set([
        ...game.collectionIds,
        ...collections
          .filter((collection) => collection.kind === "smart" && collection.smartPreset && matchesSmartPreset(game, collection.smartPreset))
          .map((collection) => collection.id),
      ])),
    })), [collections, games]);
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

  // Settle the scroll once the pick is actually on the page.
  //
  // The draw scrolls before the animation so it does not play off-screen, but at
  // that moment the result card does not exist yet - the page is shorter, so how
  // far it can scroll is smaller, and the deck rail runs its own scroll during
  // the reveal which can interrupt a smooth one that is still animating. Aiming
  // at the same element again afterwards corrects both without fighting itself.
  useEffect(() => {
    if (drawState !== "revealed" || !revealedPickId) return;
    const target = resultRef.current ?? drawStageRef.current;
    if (!target) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frame = requestAnimationFrame(() => {
      // Only if it is not already where it should be, so a draw made from the
      // right place does not jiggle.
      if (Math.abs(target.getBoundingClientRect().top - DRAW_STAGE_OFFSET) < 24) return;
      target.scrollIntoView({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });
    });
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

    // A Collection Draw drops session, mood and goal, so every game in it scores
    // zero and the pool is left in title order. Cutting that to a 64-game deck and
    // then to a finalist slice meant only alphabetically-early titles could ever
    // win. The collection IS the pool, drawn uniformly — the same reasoning that
    // already gives Quick Draw its own uniform path.
    const uniform = quick || collectionDraw;
    let activeDeck = quick ? quickPool : collectionDraw ? fullPool : deck;
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
      // Deferring reorders the deck; a uniform draw has no deck to reorder and must
      // keep its whole pool, or the 64-game cut comes back in through this path.
      if (!uniform) activeDeck = buildVaultDeck(fullPool, nextDeferredIds);
    }

    let availablePool = activeDeck.filter((entry) => !drawnCycleRef.current.has(entry.game.id));
    if (!availablePool.length) {
      drawnCycleRef.current.clear();
      availablePool = activeDeck;
    }
    // A uniform draw ranks nothing, so it takes no part in the experiment.
    const arm = uniform ? "control" : nextArm();
    const nextPick = uniform
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

    // Move to the pick before anything starts moving. Drawing from halfway up the
    // setup meant the animation played somewhere off-screen and the result was
    // simply there by the time you scrolled down to it. The draw bar is the
    // anchor rather than the card itself, so the button that rerolls stays in
    // view alongside whatever it just produced.
    await scrollToDrawStage(resultRef.current ?? drawStageRef.current, reducedMotion);
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
      finalistAppIds: uniform ? undefined : vaultFinalists(availablePool, currentPick?.id).map((entry) => entry.game.steamAppId).filter((appId): appId is number => typeof appId === "number" && appId > 0)
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
        preview_mode: !isLive,
      });
    } catch (error) {
      if (activeDraw !== activeDrawRef.current) return;
      console.error("Vault draw failed", error);
      // A draw that never records is invisible in analytics unless it says so:
      // Quick Draw shipped broken precisely because only successes reported.
      trackEvent(ANALYTICS_EVENTS.vaultDrawFailed, {
        draw_mode: quick ? "quick" : collectionMode ? "collection" : "vault",
        reason: error instanceof Error ? error.message : "unknown",
        preview_mode: !isLive,
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
    trackEvent(ANALYTICS_EVENTS.vaultSetupChanged, {
      step,
      value: id,
      preview_mode: !isLive,
    });
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

      {!isLive ? (
        <GuestPreviewNotice feature="Vault" icon="current-pick" actionLabel="Shuffle my library" catalogueSize={ownedGames.length}>
          Draw from {ownedGames.length} popular Steam games or try a catalogue collection. Your picks and history last for this visit only.
        </GuestPreviewNotice>
      ) : null}

      <section className={styles.setupLayout} aria-label="Vault draw setup" data-paused={collectionMode || undefined}>
        <div className={styles.optionStack}>
          <VaultOptionGroup title="Session" stepNumber={1} options={vaultSessionOptions} selectedId={session} selectedLabel={sessionLabel} expanded={openSetupStep === "session"} state={session ? "complete" : openSetupStep === "session" ? "active" : "pending"} onToggle={() => focusSetupStep("session")} onSelect={(id) => selectSetupOption("session", id)} />
          <VaultOptionGroup title="Mood" stepNumber={2} options={vaultMoodOptions} selectedId={mood} selectedLabel={moodLabel} expanded={openSetupStep === "mood"} state={mood ? "complete" : openSetupStep === "mood" ? "active" : "pending"} onToggle={() => focusSetupStep("mood")} onSelect={(id) => selectSetupOption("mood", id)} />
          <VaultOptionGroup title="Goal" stepNumber={3} options={vaultGoalOptions} selectedId={goal} selectedLabel={goalLabel} expanded={openSetupStep === "goal"} state={goal ? "complete" : openSetupStep === "goal" ? "active" : "pending"} onToggle={() => focusSetupStep("goal")} onSelect={(id) => selectSetupOption("goal", id)} lockedOptionIds={isLive ? [] : ["finish"]} onLockedSelect={() => setGuestSignInOpen(true)} />
        </div>

        <div className={styles.setupSidebar}>
          {/* Collapsed by default: it is the optional step, and open it took as
              much room as the three required ones together. */}
          <aside className={styles.optionalSetup} aria-label="Optional genre filters" data-disabled={collectionMode || undefined}>
            <button
              type="button"
              className={styles.optionalHeader}
              aria-expanded={genresOpen}
              aria-controls="vault-genre-filters"
              onClick={() => setGenresOpen((open) => !open)}
            >
              <span className={styles.optionalIcon}><VaultIcon name="filter" size={21} /></span>
              <span className={styles.optionalCopy}><strong>Genre filters</strong><small>{collectionMode ? "Vault Draw only · collection mode ignores filters" : selectedGenres.length ? `${selectedGenres.length} of 3 selected` : "Optional · no filters selected"}</small></span>
              <span className={styles.optionalLabel}>{collectionMode ? "Paused" : "Optional"}</span>
              <VaultIcon className={styles.optionalChevron} name="chevron-down" size={17} />
            </button>
            {genresOpen ? (
              <div className={styles.optionalContent} id="vault-genre-filters">
                <div className={styles.genreSetup}>
                  <VaultGenrePanel selectedGenres={selectedGenres} onToggleGenre={toggleGenre} onClear={clearGenres} embedded disabled={collectionMode} />
                </div>
              </div>
            ) : null}
          </aside>
        </div>
      </section>

      <section ref={drawStageRef} className={styles.drawActionBar} aria-label="Vault draw status" data-mode={drawMode}>
        <div className={styles.drawModePicker}>
          <div className={styles.drawModeToggle} role="tablist" aria-label="Draw type">
            <button type="button" role="tab" aria-selected={!collectionMode} className={styles.drawModeButton} data-active={!collectionMode || undefined} onClick={() => setDrawMode("vault")}><VaultIcon name="draw-from-vault" size={17} />Vault Draw</button>
            <button type="button" role="tab" aria-selected={collectionMode} className={styles.drawModeButton} data-active={collectionMode || undefined} onClick={activateCollectionDraw}><VaultIcon name="collections" size={17} />Collection Draw</button>
          </div>
          {/* The picker is only the question "which collection", so it only asks
              once Collection Draw is the mode. It used to sit here permanently
              as a second, differently worded way to switch modes. */}
          {collectionMode ? (
            <VaultCollectionCard
              triggerId="vault-collection-picker-trigger"
              selectedCollection={selectedCollection ?? entireVault}
              collections={collections}
              collectionCounts={collectionCounts}
              onSelect={selectDrawCollection}
              selectionActive={collectionDraw}
              allowEntireVault={false}
            />
          ) : (
            <p className={styles.setupStatus} id="vault-setup-status">{setupStatusMessage}</p>
          )}
        </div>
        <div className={styles.drawActionControl}>
          <button type="button" className={styles.ctaButton} onClick={handlePrimaryDrawAction} disabled={drawingRef.current || (collectionMode ? Boolean(selectedCollection && !deck.length) : (!nextSetupStep && !deck.length))} aria-busy={drawingRef.current} aria-describedby="vault-setup-status">
            <VaultIcon name="draw-from-vault" size={22} />{drawButtonLabel}
          </button>
          <button type="button" className={styles.quickDrawButton} onClick={() => void handleOpenVault({ quick: true })} disabled={drawingRef.current || !quickPool.length}>
            <VaultIcon name="surprise-me" size={16} />Skip it, just pick something
          </button>
        </div>
      </section>


      <p className="visually-hidden" aria-live="polite">{drawMessage}</p>

      {currentPick ? (
        <section ref={resultRef} className={`${styles.resultCard} ${drawState === "revealed" ? styles.resultRevealed : ""}`} data-visible={drawState === "revealed"}>
          {/* Artwork and the name sit side by side rather than stacked, so the
              description fills the room beside the image instead of the card
              spending a whole band on each in turn. */}
          <div className={styles.resultTop}>
            <div className={styles.resultArtwork}>
              <Artwork src={currentPick.bannerUrl} sizes="(max-width: 820px) 100vw, 36vw" priority fit="cover" />
              <span className={styles.currentPickBadge}><VaultIcon name="current-pick" size={18} />Current pick</span>
            </div>
            <div className={styles.resultIntro}>
              <div className={styles.resultHeading}><h2 className={styles.resultTitle}>{currentPick.title}</h2><VaultIcon name="new" size={22} /></div>
              <p className={styles.resultCopy}>{currentPick.description}</p>
            </div>
          </div>
          <div className={styles.resultBody}>
            {(() => {
              if (currentPickExplanation) return <VaultMatchReasons explanation={currentPickExplanation} />;
              // A Collection Draw has no session, mood or goal to reason from, so
              // there is nothing to explain - and a heading over an empty row was
              // asking a question the card could not answer. The buttons move up
              // to fill the space, which is right when there is genuinely none.
              const reasons = fullPool.find((entry) => entry.game.id === currentPick.id)?.reasons ?? [];
              if (!reasons.length) return null;
              return (
                <>
                  <p className={styles.reasonLabel}>Why it&apos;s a great match</p>
                  <div className={styles.resultReasonRow}>
                    {reasons.map((reason) => <FilterPill key={reason} label={reason} />)}
                  </div>
                </>
              );
            })()}
            {currentDrawId ? <div className={styles.feedbackRow}>
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

            {currentDrawId && rerollCount >= 3 && !rerollReasonGiven ? <div className={styles.rerollAsk}>
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

            {/* Three, deliberately, and unlabelled: filled in the colour of what
                they do, they do not need a heading above them. Draw Again lives
                in the bar directly above this card where it stays visible
                alongside the pick, completion has its own sweep, and details are
                a click away on any deck card. */}
            <div className={styles.resultActions}>
              <a href={isLive ? steamLaunchUrl(currentPick.steamAppId) : steamStoreUrl(currentPick.steamAppId)} target={isLive ? undefined : "_blank"} rel={isLive ? undefined : "noreferrer"} className={`${styles.resultAction} ${styles.resultActionPrimary}`} data-action="steam" onClick={() => currentDrawId ? void recordDrawEvent(currentDrawId, "opened_on_steam", drawEventAnalytics()) : undefined}>
                <VaultResultActionIcon name="open-steam" /><span className={styles.resultActionCopy}><strong>{isLive ? "Open on Steam" : "View on Steam"}</strong></span>
              </a>
              <button type="button" className={styles.resultAction} data-action="snooze" onClick={() => { if (currentDrawId) void recordDrawEvent(currentDrawId, "hidden_for_session", drawEventAnalytics()); void snoozeCurrentPick(); }}>
                <VaultResultActionIcon name="snooze-not-now" /><span className={styles.resultActionCopy}><strong>Snooze</strong></span>
              </button>
              <button type="button" className={styles.resultAction} data-action="pin" onClick={() => { void togglePin(currentPick.id); if (currentDrawId) void recordDrawEvent(currentDrawId, vaultState.pinnedIds.includes(currentPick.id) ? "unpinned" : "pinned", drawEventAnalytics()); }}>
                <VaultResultActionIcon name="pin" /><span className={styles.resultActionCopy}><strong>{vaultState.pinnedIds.includes(currentPick.id) ? "Pinned" : vaultState.pinnedIds.length >= 3 ? "Pins full" : "Pin"}</strong></span>
              </button>
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

      {/* The deck sits at the very bottom: it is what the draw chose FROM, so it
          reads as supporting evidence after the pick rather than a wall of
          sixty-four games between the setup and the answer. */}
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
                aria-expanded={historyOpen}
                aria-haspopup="dialog"
                onClick={() => {
                  setHistoryOpen(true);
                  void loadVaultHistory();
                  trackEvent(ANALYTICS_EVENTS.vaultHistoryOpened, { preview_mode: !isLive });
                }}
              >
                <span className={styles.deckToolIcon}><VaultIcon name="clock" size={21} /></span>
                <span className={styles.deckToolCopy}><strong>Draw History</strong><small>{isLive ? "Revisit previous picks" : "Saved for this visit"}</small></span>
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
            allowActions
          />
        ) : (
          <div className={styles.emptyState}>
            <h3 className={styles.emptyTitle}>{collectionMode ? selectedCollection ? "No active games in this collection." : "Choose a collection to build this deck." : "No games matched that combination."}</h3>
            <p className={styles.emptyCopy}>{collectionMode ? selectedCollection ? "Try another collection or switch back to Vault Draw." : "Collection Draw uses every active game in the collection, without extra filters." : "Try loosening the genre filters or switch to Surprise Me for a wider pool."}</p>
            {collectionMode ? <button type="button" className={styles.secondaryAction} onClick={() => setDrawMode("vault")}>Use Vault Draw</button> : <button type="button" className={styles.secondaryAction} onClick={clearGenres}>Clear genre filters</button>}
          </div>
        )}

      </section>

      {/* Pin props matter here: without them the drawer's pin button renders
          disabled, so opening a deck card and trying to pin it did nothing. */}
      <LibraryDetailsDrawer
        game={detailsGame}
        previewMode={!isLive}
        collections={collections}
        saving={savingGameId === detailsGame?.id}
        pinSlot={detailsGame ? vaultState.pinnedIds.indexOf(detailsGame.id) + 1 || null : null}
        pinCount={vaultState.pinnedIds.length}
        onTogglePin={() => { if (detailsGame) void togglePin(detailsGame.id); }}
        onManagePins={() => { if (detailsGame) setPinCandidate(detailsGame); }}
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
      />
      <VaultHistoryDrawer
        open={historyOpen}
        draws={vaultHistory}
        games={ownedGames}
        onClose={() => setHistoryOpen(false)}
        onClear={clearVaultHistory}
        onViewDetails={(game) => {
          setHistoryOpen(false);
          setDetailsGameId(game.id);
        }}
      />
      <GuestSignInPrompt open={guestSignInOpen} onClose={closeGuestSignInPrompt} catalogueSize={ownedGames.length} reason="finish_goal" />
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

/**
 * The gap left above the pick, and what "already there" means. Matches
 * scroll-margin-top on the result card.
 *
 * The pick is the anchor rather than the draw bar. Anchoring the bar, at any
 * offset, left the card starting a whole bar-height down the screen - which is
 * why tuning the number never fixed it.
 */
const DRAW_STAGE_OFFSET = 20;

async function scrollToDrawStage(element: HTMLElement | null, reducedMotion: boolean) {
  if (!element) return;
  // scrollIntoView rather than arithmetic: the gap under the sticky header is
  // scroll-margin-top on the bar itself, so the offset lives with the thing it
  // describes instead of being a number here that has to stay in sync.
  element.scrollIntoView({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });
  await waitForScrollEnd(reducedMotion);
}

/**
 * Resolves once the page has actually stopped moving.
 *
 * scrollend is not available everywhere yet, so a poll backs it up, and a hard
 * cap guarantees a draw can never hang waiting for a scroll that never settles.
 */
function waitForScrollEnd(reducedMotion: boolean): Promise<void> {
  if (reducedMotion) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let lastOffset = window.scrollY;
    let stillTicks = 0;
    let hasMoved = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener("scrollend", finish);
      clearTimeout(cap);
      clearInterval(poll);
      resolve();
    };

    const cap = setTimeout(finish, 700);
    const poll = setInterval(() => {
      const offset = window.scrollY;
      if (Math.abs(offset - lastOffset) >= 1) {
        hasMoved = true;
        stillTicks = 0;
        lastOffset = offset;
        return;
      }
      stillTicks += 1;
      // Once it has moved and then stopped, the scroll is done. If it never
      // moves at all - already in place, or a page that cannot scroll - give it
      // a short grace period and then get on with the draw rather than holding
      // the animation for something that is not going to happen.
      if (hasMoved ? stillTicks >= 3 : stillTicks >= 6) finish();
    }, 50);

    window.addEventListener("scrollend", finish, { once: true });
  });
}

function ResultSummary({ icon, label, value }: { icon: "clock" | "mood" | "goal" | "genre" | "collections"; label: string; value: string }) {
  return <div className={styles.summaryItem}><VaultIcon name={icon} size={23} /><span><small>{label}</small><strong>{value}</strong></span></div>;
}

type VaultResultActionIconName = "open-steam" | "pin" | "draw-again" | "snooze-not-now" | "view-details" | "mark-completed" | "all-games";

function VaultResultActionIcon({ name }: { name: VaultResultActionIconName }) {
  return <span className={styles.resultActionIcon} aria-hidden="true"><VaultIcon name={name} size={48} /></span>;
}
