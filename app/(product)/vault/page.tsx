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
import { VaultHistoryPanel } from "@/components/vault/VaultHistoryPanel";
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
  vaultSessionOptions,
  type VaultMatchExplanation
} from "@/lib/vault";
import { steamLaunchUrl, steamStoreUrl } from "@/lib/steam-images";
import { useCanLaunchSteam } from "@/components/shared/useSteamLaunch";
import { formatGameDuration } from "@/lib/game-duration";
import { matchesSmartPreset } from "@/lib/smart-collections";
import { ANALYTICS_EVENTS, trackEvent } from "@/lib/analytics";
import { trackCompletionClaim, trackCompletionUndone } from "@/lib/completion-tracking";
import styles from "./vault.module.css";

type VaultDrawState = "idle" | "focusing" | "revealing" | "revealed" | "error";
type VaultSetupStep = "session" | "mood" | "goal";
/**
 * The four panels of the setup, of which one is open at a time.
 *
 * Genres used to keep its own open flag, so it could sit open behind a question
 * you had gone back to change. It is the same kind of thing as the other three -
 * a question about the draw - and it behaves like them now: opening any one
 * closes the rest.
 */
type VaultSetupPanel = VaultSetupStep | "genres";
type VaultDrawMode = "vault" | "collection";
type DeferredDeckQueue = { setupKey: string; gameIds: string[] };

/**
 * The draw that produced the pick on screen, frozen at the moment it landed.
 *
 * The result card used to describe the setup as it stood right now, not the one
 * the draw actually ran with. Editing the genre filters afterwards therefore
 * rewrote the card underneath you - and usually emptied it, because the pick
 * would fall out of the newly filtered pool and there was no entry left to
 * explain. Nothing you change after a draw belongs on the card for that draw;
 * it belongs on the next one.
 */
type DrawSnapshot = {
  pickId: string;
  explanation: VaultMatchExplanation | null;
  reasons: string[];
  collectionDraw: boolean;
  collectionName: string | null;
  session: VaultSessionId | null;
  mood: VaultMoodId | null;
  goal: VaultGoalId | null;
  genres: string[];
};
const EMPTY_GAME_IDS: string[] = [];

export default function VaultPage() {
  const { games, collections, vaultState, genrePreferences: learnedGenrePreferences, genrePreferenceGlobals: learnedGenreGlobals, vaultHistory, isLive, recordVaultAction, recordVaultDraw, loadVaultHistory, recordDrawEvent, clearVaultHistory, updateGame, restoreGame, setGameCollection } = useAppData();
  const [session, setSession] = useState<VaultSessionId | null>(null);
  const [mood, setMood] = useState<VaultMoodId | null>(null);
  const [goal, setGoal] = useState<VaultGoalId | null>(null);
  const [openSetupStep, setOpenSetupStep] = useState<VaultSetupPanel | null>("session");
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

  // The undo toasts had no timer at all, so they sat on the corner of the screen
  // until you dismissed them by hand. Longer than the pin message because there
  // is something to decide here, but still a window rather than a fixture.
  useEffect(() => {
    if (!sleepUndo) return;
    const timer = window.setTimeout(() => setSleepUndo(null), 9000);
    return () => window.clearTimeout(timer);
  }, [sleepUndo]);

  useEffect(() => {
    if (!completionUndo) return;
    const timer = window.setTimeout(() => setCompletionUndo(null), 9000);
    return () => window.clearTimeout(timer);
  }, [completionUndo]);
  const [drawState, setDrawState] = useState<VaultDrawState>("idle");
  // What the rail focuses on, set when the draw starts so the animation knows
  // where it is heading.
  const [drawWinnerId, setDrawWinnerId] = useState<string | null>(null);
  // What the result card shows, set only once the reveal lands. These used to be
  // the same value, so the card named the game at the moment the draw started —
  // the answer arrived a full animation before the animation that announces it.
  const [revealedPickId, setRevealedPickId] = useState<string | null>(null);
  const [drawMessage, setDrawMessage] = useState("");
  // The two deck tools open into the same strip below the bar, so they are one
  // disclosure rather than two booleans that can both be true and stack two
  // panels between you and the pick.
  // Guests were always sent to the store page; signed-in users were sent to
  // steam://run, which does nothing without the desktop client. Most people
  // drawing are on a phone, so the product's primary action did nothing for
  // them. A device that can launch gets the launch.
  const canLaunchSteam = useCanLaunchSteam();
  const steamPlayIsLaunch = isLive && canLaunchSteam;
  const [deckPanel, setDeckPanel] = useState<"lens" | "history" | null>(null);
  const [currentDrawId, setCurrentDrawId] = useState<string | null>(null);
  const [guestSignInOpen, setGuestSignInOpen] = useState(false);
  const [drawSnapshot, setDrawSnapshot] = useState<DrawSnapshot | null>(null);
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
  // Taken from the draw that produced this pick rather than recomputed, so the
  // card keeps describing the draw it belongs to however the setup is edited
  // afterwards. The id guard covers the pick changing out from under it - being
  // slept or snoozed - which leaves the snapshot describing a game that is no
  // longer on screen.
  const pickDraw = drawSnapshot && currentPick && drawSnapshot.pickId === currentPick.id ? drawSnapshot : null;

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
  // Derived from state, not from drawingRef. A ref read during render does not
  // re-render when it changes, so the buttons only happened to disable because
  // setDrawState fired at roughly the same moment. drawingRef stays as the
  // re-entrancy guard inside the handler, which is what it is for.
  const isDrawing = drawState === "focusing" || drawState === "revealing";

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
    const target = drawStageRef.current;
    if (!target) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frame = requestAnimationFrame(() => {
      // Only if it is not already in place, so a draw made from the right spot
      // does not jiggle.
      if (Math.abs(target.getBoundingClientRect().top - DRAW_STAGE_OFFSET) < 24) return;
      target.scrollIntoView({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [drawState, revealedPickId]);


  // A new setup means a new deck, so the draw cycle starts over: the queue, the
  // already-drawn set and the deck highlight all belong to the deck that just
  // stopped existing.
  //
  // The draw id does not. It identifies the pick still on screen, and it is what
  // "Good pick?" and every follow-up - opened on Steam, pinned, snoozed - are
  // recorded against. Clearing it took the feedback row off a card that was
  // still sitting there, for the same reason the card itself is frozen: what you
  // change now applies to the next draw, not the one you already have.
  useEffect(() => {
    const resetQueue = { setupKey, gameIds: [] };
    activeDrawRef.current += 1;
    drawingRef.current = false;
    drawnCycleRef.current.clear();
    deferredQueueRef.current = resetQueue;
    setDeferredQueue(resetQueue);
    setHighlightedGameId(null);
    setDrawWinnerId(null);
    // Idle only if a draw was in flight, which this has just cancelled. A
    // revealed pick stays revealed - leaving "focusing" would disable the draw
    // button for good, and forcing "idle" drops the card's revealed treatment.
    setDrawState((current) => (current === "revealed" ? "revealed" : "idle"));
    setDrawMessage("");
  }, [setupKey]);

  // The Lens opens itself when a deck comes back empty - but only when empty is
  // surprising, which means a finished setup that matched nothing.
  //
  // An unfinished one is empty by design and the page already says why: pressing
  // Collection Draw empties the deck until you choose a collection, and it puts
  // "Choose a collection to build this deck" on screen while it waits. Treating
  // that as something to explain popped the Lens open on a plain mode switch.
  const setupComplete = collectionMode ? Boolean(selectedCollection) : !nextSetupStep;
  const deckEmptyUnexpectedly = setupComplete && !deck.length;
  useEffect(() => {
    // Only into a strip nothing else is using, and only when the answer changes,
    // so closing it stays closed.
    if (deckEmptyUnexpectedly) setDeckPanel((current) => current ?? "lens");
  }, [deckEmptyUnexpectedly]);

  async function handleOpenVault({ deferCurrentPick = false, quick = false }: { deferCurrentPick?: boolean; quick?: boolean } = {}) {
    // Quick Draw bypasses the setup gate on purpose: it exists for the visitor who
    // has not filled anything in and wants a game anyway.
    if (drawingRef.current || (!quick && !canDraw)) return;
    if (quick && !quickPool.length) return;
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

    // Built from the inputs this draw is running with, captured here rather than
    // read again at render time, when they may have moved on.
    const describeDraw = (pickId: string): DrawSnapshot => {
      const explanationPool = quick ? quickPool : fullPool;
      const entry = explanationPool.find((candidate) => candidate.game.id === pickId) ?? null;
      // Explained only when the draw actually reasoned: a Quick Draw ignores the
      // setup entirely and a Collection Draw drops session, mood and goal.
      // Scoring them anyway put a "Why it's a great match" panel on the card
      // headed "Eligible pick · 0/100" - a score of nothing, dressed as
      // reasoning, for a draw that reasoned about nothing.
      const guided = !quick && !collectionMode;
      return {
        pickId,
        explanation: guided && entry
          ? buildVaultMatchExplanation({
              entry,
              pool: explanationPool,
              session: activeSession,
              mood: activeMood,
              goal: activeGoal,
              selectedGenres: activeGenres
            })
          : null,
        // Quick Draw picks at random from everything eligible. There is no match
        // to describe, so the card says nothing rather than reaching for
        // whatever the pool happened to note about the game.
        reasons: quick ? [] : entry?.reasons ?? [],
        collectionDraw,
        collectionName: selectedCollection?.name ?? null,
        session,
        mood,
        goal,
        genres: selectedGenres
      };
    };

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
    await scrollToDrawStage(drawStageRef.current, reducedMotion);
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
      setDrawSnapshot(describeDraw(nextPick.id));
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
    } catch (error) {
      if (activeDraw !== activeDrawRef.current) return;
      console.error("Vault draw failed", error);
      // A draw that never records is invisible in analytics unless it says so:
      // Quick Draw shipped broken precisely because only successes reported.
      trackEvent(ANALYTICS_EVENTS.vaultDrawFailed, {
        draw_mode: quick ? "quick" : collectionMode ? "collection" : "vault",
        reason: error instanceof Error ? error.message : "unknown",
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

    if (nextStep) {
      setOpenSetupStep(nextStep);
      revealSetupStep(nextStep);
      return;
    }

    // All three answered. The questions fold away and the one choice still open
    // to you takes their place, which is the same handover the setup already
    // does between the three - it just used to stop at the last one and leave it
    // sitting open with nothing left to answer.
    setOpenSetupStep(selectedGenres.length ? null : "genres");
    if (!selectedGenres.length) revealGenreFilters();
  }

  /* Matches revealSetupStep: only moves the page if the panel is not already
     where you can see it, so finishing the setup from the right spot does not
     jump. No focus steal - nothing here has to be answered. */
  function revealGenreFilters() {
    window.requestAnimationFrame(() => {
      const element = document.getElementById("vault-genre-filters")?.closest("aside");
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      if (bounds.top < 96 || bounds.bottom > window.innerHeight - 96) {
        element.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
      }
    });
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
      // Drawing over a pick is a reroll, and a rerolled pick goes to the back of
      // the whole pool rather than staying in the deck. Nothing passed this, so
      // the deck was the same top 64 every time: once all 64 had been drawn the
      // cycle reset and the first ones came straight back, with the other few
      // hundred eligible games never getting a turn.
      void handleOpenVault({ deferCurrentPick: Boolean(currentPick) });
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

  /* Toggling is a state update; fetching the history and reporting the open are
     not, so they stay out of the updater React is free to run twice. */
  function openDrawHistory() {
    if (deckPanel === "history") {
      setDeckPanel(null);
      return;
    }
    setDeckPanel("history");
    void loadVaultHistory();
    trackEvent(ANALYTICS_EVENTS.vaultHistoryOpened);
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
          {/* Lit once the three required steps are answered and this is the only
              choice left. As the one dim row under three bright ones it was easy
              to scroll straight past. */}
          <aside
            className={styles.optionalSetup}
            aria-label="Optional genre filters"
            data-disabled={collectionMode || undefined}
            data-ready={!collectionMode && !nextSetupStep && !selectedGenres.length || undefined}
          >
            <button
              type="button"
              className={styles.optionalHeader}
              aria-expanded={openSetupStep === "genres"}
              aria-controls="vault-genre-filters"
              onClick={() => setOpenSetupStep((current) => (current === "genres" ? null : "genres"))}
            >
              <span className={styles.optionalIcon}><VaultIcon name="filter" size={21} /></span>
              <span className={styles.optionalCopy}><strong>Genre filters</strong><small>{collectionMode ? "Vault Draw only · collection mode ignores filters" : selectedGenres.length ? `${selectedGenres.length} of 3 selected` : !nextSetupStep ? "Optional · narrow the deck by genre" : "Optional · no filters selected"}</small></span>
              <span className={styles.optionalLabel}>{collectionMode ? "Paused" : "Optional"}</span>
              <VaultIcon className={styles.optionalChevron} name="chevron-down" size={17} />
            </button>
            {openSetupStep === "genres" ? (
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
          ) : null}
          {/* The visible copy of this said "Start by choosing how much time you
              have" directly beneath a button reading "Choose a session". It is
              still here for the button's aria-describedby, where it is the only
              wording a screen reader gets. */}
          <p className="visually-hidden" id="vault-setup-status">{setupStatusMessage}</p>
        </div>
        {/* The bar had a wide empty middle while these sat in a band of their
            own further down the page. Neither is part of setting a draw up, so
            they take the middle rather than a row of their own. */}
        {/* The wrapper is what the tools are measured against. A container
            cannot query itself, so the slot holds the width and the grid inside
            reacts to it. */}
        <div className={styles.deckToolsSlot}>
          <div className={styles.deckTools}>
          <button
            type="button"
            className={styles.deckToolButton}
            data-active={deckPanel === "lens" || undefined}
            aria-expanded={deckPanel === "lens"}
            aria-controls="vault-lens-panel"
            onClick={() => setDeckPanel((current) => (current === "lens" ? null : "lens"))}
          >
            <span className={styles.deckToolIcon}><VaultIcon name="details" size={21} /></span>
            <span className={styles.deckToolCopy}><strong>Vault Lens</strong><small>How this deck was built</small></span>
            <VaultIcon className={styles.deckToolChevron} name="chevron-down" size={17} />
          </button>
          <button
            type="button"
            className={styles.deckToolButton}
            data-active={deckPanel === "history" || undefined}
            aria-expanded={deckPanel === "history"}
            aria-controls="vault-history-panel"
            onClick={openDrawHistory}
          >
            <span className={styles.deckToolIcon}><VaultIcon name="clock" size={21} /></span>
            <span className={styles.deckToolCopy}><strong>Draw History</strong><small>{isLive ? "Revisit previous picks" : "Saved for this visit"}</small></span>
            <VaultIcon className={styles.deckToolChevron} name="chevron-down" size={17} />
          </button>
          </div>
        </div>
        <div className={styles.drawActionControl}>
          <button type="button" className={styles.ctaButton} onClick={handlePrimaryDrawAction} disabled={isDrawing || (collectionMode ? Boolean(selectedCollection && !deck.length) : (!nextSetupStep && !deck.length))} aria-busy={isDrawing} aria-describedby="vault-setup-status">
            <VaultIcon name="draw-from-vault" size={22} />{drawButtonLabel}
          </button>
          <button type="button" className={styles.quickDrawButton} onClick={() => void handleOpenVault({ quick: true })} disabled={isDrawing || !quickPool.length}>
            <VaultIcon name="shuffle" size={16} />Skip it, just pick something
          </button>
        </div>
      </section>

      {/* Directly under the bar, so a panel opens next to the button that
          toggles it rather than somewhere further down the page. */}
      {deckPanel === "lens" ? <VaultLens stages={eligibility.stages} selectedCollection={collectionDraw} selectedGenres={Boolean(activeGenres.length)} snoozedCount={snoozedIds.size} onClearGenres={clearGenres} onUseEntireVault={() => setDrawMode("vault")} onClearSnoozes={() => void clearSnoozes()} /> : null}
      {deckPanel === "history" ? (
        <VaultHistoryPanel
          draws={vaultHistory}
          games={ownedGames}
          isLive={isLive}
          onClear={clearVaultHistory}
          onViewDetails={(game) => {
            setDeckPanel(null);
            setDetailsGameId(game.id);
          }}
        />
      ) : null}

      <p className="visually-hidden" aria-live="polite">{drawMessage}</p>

      {currentPick ? (
        // Keyed on the pick, so a re-draw replaces the card rather than editing
        // it in place. Editing meant every line changed on the same frame with
        // nothing to carry the eye across, which is the flash.
        <section
          key={currentPick.id}
          ref={resultRef}
          className={`${styles.resultCard} ${drawState === "revealed" ? styles.resultRevealed : ""}`}
          data-visible={drawState === "revealed"}
          data-drawing={isDrawing || undefined}
        >
          {/* Artwork and the name sit side by side rather than stacked, so the
              description fills the room beside the image instead of the card
              spending a whole band on each in turn. */}
          <div className={styles.resultTop}>
            <div className={styles.resultArtwork}>
              <Artwork src={currentPick.bannerUrl} sizes="(max-width: 820px) 100vw, 36vw" priority fit="cover" />
            </div>
            <div className={styles.resultIntro}>
              {/* Beside the name rather than over the artwork, where it was covering the
                  part of the header art the game chose to put its title on. */}
              <div className={styles.resultHeading}>
                <h2 className={styles.resultTitle}>{currentPick.title}</h2>
                <VaultIcon name="new" size={22} />
                <span className={styles.currentPickBadge}><VaultIcon name="current-pick" size={16} />Current pick</span>
              </div>
              <p className={styles.resultCopy}>{currentPick.description}</p>
              {/* Sat on the summary bar until it ran out of room and truncated
                  to "ESTIMATED PLAYTHROUG". It reads better next to the game it
                  describes, in space that was going spare. */}
              {formatGameDuration(currentPick.duration) ? (
                <p className={styles.resultDuration}>
                  <VaultIcon name="clock" size={15} />
                  {formatGameDuration(currentPick.duration)}
                  {currentPick.hoursPlayed > 0 ? <span>· {currentPick.hoursPlayed}h played</span> : null}
                </p>
              ) : null}
            </div>
          </div>
          <div className={styles.resultBody}>
            {(() => {
              if (pickDraw?.explanation) return <VaultMatchReasons explanation={pickDraw.explanation} />;
              // A Collection Draw has no session, mood or goal to reason from, so
              // there is nothing to explain - and a heading over an empty row was
              // asking a question the card could not answer. The buttons move up
              // to fill the space, which is right when there is genuinely none.
              const reasons = pickDraw?.reasons ?? [];
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
              <a href={steamPlayIsLaunch ? steamLaunchUrl(currentPick.steamAppId) : steamStoreUrl(currentPick.steamAppId)} target={steamPlayIsLaunch ? undefined : "_blank"} rel={steamPlayIsLaunch ? undefined : "noreferrer"} className={`${styles.resultAction} ${styles.resultActionPrimary}`} data-action="steam" onClick={() => currentDrawId ? void recordDrawEvent(currentDrawId, "opened_on_steam", drawEventAnalytics()) : undefined}>
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
            {pickDraw?.collectionDraw ? <>
              <ResultSummary icon="collections" label="Collection Draw" value={pickDraw.collectionName ?? "Collection"} />
              <ResultSummary icon="genre" label="Filters" value="Collection only" />
            </> : <>
              <ResultSummary icon="clock" label="Session" value={vaultSessionOptions.find((option) => option.id === pickDraw?.session)?.shortLabel ?? "Not selected"} />
              <ResultSummary icon="mood" label="Mood" value={vaultMoodOptions.find((option) => option.id === pickDraw?.mood)?.label ?? "Not selected"} />
              <ResultSummary icon="goal" label="Goal" value={vaultGoalOptions.find((option) => option.id === pickDraw?.goal)?.label ?? "Not selected"} />
              <ResultSummary icon="genre" label="Genres" value={pickDraw?.genres.length ? pickDraw.genres.join(" · ") : "All"} />
            </>}
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
          />


          {/* The setup pills that used to sit here restated session, mood and goal,
              which the pick's own summary bar shows directly above. What is worth
              keeping is the case where the deck is empty and the reason why. */}
          {collectionMode && !selectedCollection ? <span className={styles.noFilters}>Choose a collection to build this deck.</span> : null}
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

/** The gap left above the draw bar. Matches scroll-margin-top on it. */
const DRAW_STAGE_OFFSET = 30;

/**
 * Put the draw bar just under the top of the window; the pick follows directly
 * beneath it.
 *
 * Anchoring the bar rather than centring on the card or its buttons, because
 * this has to land in the same place every time. Centring is measured from the
 * middle of the target, so the further the card grows or shrinks - two reasons
 * or four, a one-line description or two - the further the page scrolls. The
 * bar is a fixed height and always directly above the pick, so aligning it puts
 * everything else where it was last time.
 */
async function scrollToDrawStage(element: HTMLElement | null, reducedMotion: boolean) {
  if (!element) return;
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
