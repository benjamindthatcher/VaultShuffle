"use client";

import { VAULT_REROLL_REASONS, type VaultDrawEventType } from "@/lib/vault-history";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { LibraryDetailsDrawer } from "@/components/library/LibraryDetailsDrawer";
import { FilterPill } from "@/components/shared/FilterPill";
import { ActionIcon } from "@/components/library/LibraryGameActions";
import { FilteredSteamDeckBadge } from "@/components/shared/SteamDeckCompatibility";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { VaultShuffleLoader } from "@/components/shared/VaultShuffleLoader";
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
import { ANALYTICS_EVENTS, trackEvent, trackNavigationEvent } from "@/lib/analytics";
import { trackCompletionClaim, trackCompletionUndone } from "@/lib/completion-tracking";
import styles from "./vault.module.css";
import { playtimeIsUnknown } from "@/lib/family-sharing";
import { FamilyGameMark } from "@/components/shared/FamilyMark";
import { useV2Vault } from "@/components/vault/useV2Vault";
import { requestJson } from "@/lib/api-client";
import { libraryGame } from "@/lib/v2/library-view-model";
import type { LibraryCard } from "@/lib/v2/repositories/library-core";
import type { VaultDrawResult, VaultSetup } from "@/lib/v2/vault";
import type { GameMutationReceipt } from "@/lib/v2/game-mutation";

type VaultDrawState = "idle" | "focusing" | "revealing" | "revealed" | "error";
type VaultSetupStep = "session" | "mood" | "goal";
type VaultDetailsSurface = "pinned" | "history" | "pool";
/**
 * The four panels of the setup, of which one is open at a time.
 *
 * Genres used to keep its own open flag, so it could sit open behind a question
 * you had gone back to change. It is the same kind of thing as the other three -
 * a question about the draw - and it behaves like them now: opening any one
 * closes the rest.
 */
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
  description?: string;
  quick: boolean;
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

/** Per-tab, so a trip to Steam and back keeps your answers but a new visit does not. */
const VAULT_SETUP_KEY = "vault-setup";

export default function VaultPage() {
  const { games, allGames, collections, vaultState, genrePreferences: learnedGenrePreferences, genrePreferenceGlobals: learnedGenreGlobals, gamePreferences, vaultHistory, isLive, dataAuthority, globalFilters, libraryDataVersion, rememberLibraryGames, drawV2Vault, clearVaultSnoozes, recordVaultAction, recordVaultDraw, loadVaultHistory, recordDrawEvent, clearVaultHistory, updateGame, restoreGame, setGameCollection } = useAppData();
  const v2 = isLive && dataAuthority === "v2";
  const [session, setSession] = useState<VaultSessionId | null>(null);
  const [mood, setMood] = useState<VaultMoodId | null>(null);
  const [goal, setGoal] = useState<VaultGoalId | null>(null);
  const [openSetupStep, setOpenSetupStep] = useState<VaultSetupStep | null>("session");
  const [genreFiltersOpen, setGenreFiltersOpen] = useState(false);
  // Whether the saved setup has been read back yet. Nothing is written until it
  // has, or the first render would save its own empty state over the real one.
  const [setupRestored, setSetupRestored] = useState(false);
  const [drawMode, setDrawMode] = useState<VaultDrawMode>("vault");
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [highlightedGameId, setHighlightedGameId] = useState<string | null>(null);
  const [detailsGameId, setDetailsGameId] = useState<string | null>(null);
  const [detailsSurface, setDetailsSurface] = useState<VaultDetailsSurface | null>(null);
  const [v2Detail,setV2Detail] = useState<DemoGame|null>(null);
  const [savingGameId, setSavingGameId] = useState<string | null>(null);
  const [blacklistUndo, setBlacklistUndo] = useState<{ gameId: string; title: string; status: "Not Started" | "In Progress"; wasPinned: boolean; receipt?:GameMutationReceipt } | null>(null);
  const [pinCandidate, setPinCandidate] = useState<DemoGame | null>(null);
  const [pinContext, setPinContext] = useState<Record<string, unknown>>({ source: "vault" });
  const [savingPick, setSavingPick] = useState(false);
  const [pinMessage, setPinMessage] = useState("");

  // Confirmations are news for a moment and clutter after that. It had a
  // Dismiss button and nothing else, so it sat there until you told it to go.
  useEffect(() => {
    if (!pinMessage) return;
    const timer = window.setTimeout(() => setPinMessage(""), 4000);
    return () => window.clearTimeout(timer);
  }, [pinMessage]);
  const [completionUndo, setCompletionUndo] = useState<{ id: string; title: string; previous:DemoGame; receipt?:GameMutationReceipt } | null>(null);

  // The undo toasts had no timer at all, so they sat on the corner of the screen
  // until you dismissed them by hand. Longer than the pin message because there
  // is something to decide here, but still a window rather than a fixture.
  useEffect(() => {
    if (!blacklistUndo) return;
    const timer = window.setTimeout(() => setBlacklistUndo(null), 9000);
    return () => window.clearTimeout(timer);
  }, [blacklistUndo]);

  useEffect(() => {
    if (!completionUndo) return;
    const timer = window.setTimeout(() => setCompletionUndo(null), 9000);
    return () => window.clearTimeout(timer);
  }, [completionUndo]);
  const [drawState, setDrawState] = useState<VaultDrawState>("idle");
  // What the rail focuses on, set when the draw starts so the animation knows
  // where it is heading.
  const [drawWinnerId, setDrawWinnerId] = useState<string | null>(null);
  // Visit-local: only an explicit draw may reveal a result. Never restore this
  // from the saved current pick when opening or returning to the Vault.
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
  const [historyPending,setHistoryPending] = useState(false);
  const [currentDrawId, setCurrentDrawId] = useState<string | null>(null);
  const pendingDrawIdRef = useRef<Promise<string | null> | null>(null);
  const pendingBlacklistIdsRef = useRef(new Set<string>());
  const blacklistWritesRef = useRef(new Map<string, Promise<GameMutationReceipt|void>>());
  const undoingBlacklistRef = useRef(false);
  const [actionError, setActionError] = useState("");
  const [guestSignInOpen, setGuestSignInOpen] = useState(false);
  const [drawSnapshot, setDrawSnapshot] = useState<DrawSnapshot | null>(null);
  const [rerollCount, setRerollCount] = useState(0);
  const [drawArm, setDrawArm] = useState<GenreLearningArm>("control");
  const drawRerollIndexRef = useRef(0);
  const [rerollReasonGiven, setRerollReasonGiven] = useState(false);
  const drawingRef = useRef(false);
  const drawStageRef = useRef<HTMLElement>(null);
  const resultRef = useRef<HTMLElement>(null);
  const drawButtonRef = useRef<HTMLButtonElement>(null);
  const drawnCycleRef = useRef<Set<string>>(new Set());
  const activeDrawRef = useRef(0);
  const scrollToDrawRef = useRef(true);
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
  // Pins outrank the global filters, so a pinned game the filters have ruled out
  // still has to be findable - otherwise the dialog offers two of three pins and
  // the third cannot be replaced or removed from here at all.
  const pinnedGames = useMemo(
    () => vaultState.pinnedIds
      .map((id) => ownedGames.find((game) => game.id === id) ?? allGames.find((game) => game.id === id))
      .filter((game): game is NonNullable<typeof game> => Boolean(game)),
    [allGames, ownedGames, vaultState.pinnedIds]
  );
  const snoozedIds = useMemo(() => new Set(vaultState.snoozedIds), [vaultState.snoozedIds]);
  const drawableGames = useMemo(() => ownedGames.filter((game) => game.status !== "Completed" && game.status !== "Blacklisted" && !snoozedIds.has(game.id)), [ownedGames, snoozedIds]);
  const selectedCollection = collections.find((collection) => collection.id === selectedCollectionId) ?? null;
  const entireVault = collections.find((collection) => collection.id === "all") ?? collections[0];
  const legacyCollectionCounts = useMemo(() => Object.fromEntries(collections.map((collection) => [collection.id, collection.id === "all" ? drawableGames.length : drawableGames.filter((game) => game.collectionIds.includes(collection.id)).length])), [collections, drawableGames]);
  /**
   * Your answers survive leaving the page.
   *
   * Session, mood and goal were plain useState, so anything that unloaded the
   * page threw them away - and on a phone that is every time you tap through to
   * a game and come back. Someone reported exactly that: "when you go back you
   * always have to answer the questions again."
   *
   * sessionStorage rather than localStorage on purpose. This is meant to survive
   * a trip to Steam and back, not to answer next week's question with last
   * week's mood. Closing the tab still starts you fresh, which is right - the
   * whole point of the three questions is that the answer changes.
   *
   * Read in an effect rather than a lazy initialiser because the server renders
   * this too and has no sessionStorage; doing it during render would mismatch.
   */
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(VAULT_SETUP_KEY);
      if (saved) {
        const setup = JSON.parse(saved) as {
          session?: VaultSessionId | null;
          mood?: VaultMoodId | null;
          goal?: VaultGoalId | null;
          drawMode?: VaultDrawMode;
          selectedCollectionId?: string | null;
          selectedGenres?: string[];
        };
        if (setup.session) setSession(setup.session);
        if (setup.mood) setMood(setup.mood);
        if (setup.goal) setGoal(setup.goal);
        if (setup.drawMode) setDrawMode(setup.drawMode);
        if (setup.selectedCollectionId) setSelectedCollectionId(setup.selectedCollectionId);
        if (Array.isArray(setup.selectedGenres)) setSelectedGenres(setup.selectedGenres);
        // Resume an unfinished setup. For saved complete answers, start with
        // Session for review; Filters only opens after a choice or an explicit click.
        setOpenSetupStep(
          !setup.session ? "session"
          : !setup.mood ? "mood"
          : !setup.goal ? "goal"
          : "session"
        );
      }
    } catch { /* A malformed or unreadable draft just means starting fresh. */ }
    setSetupRestored(true);
  }, []);

  useEffect(() => {
    if (!setupRestored) return;
    try {
      sessionStorage.setItem(VAULT_SETUP_KEY, JSON.stringify({
        session, mood, goal, drawMode, selectedCollectionId, selectedGenres
      }));
    } catch { /* Private mode and full quotas are not worth an error here. */ }
  }, [setupRestored, session, mood, goal, drawMode, selectedCollectionId, selectedGenres]);

  const collectionMode = drawMode === "collection";
  const collectionDraw = collectionMode && isCollectionDraw(selectedCollectionId);
  const activeSession = collectionMode ? null : session;
  const activeMood = collectionMode ? null : mood;
  const activeGoal = collectionMode ? null : goal;
  const activeCollectionId = collectionMode ? selectedCollectionId : null;
  const activeGenres = collectionMode ? EMPTY_GAME_IDS : selectedGenres;
  const setupKey = `${drawMode}|${activeSession ?? ""}|${activeMood ?? ""}|${activeGoal ?? ""}|${activeCollectionId ?? "all"}|${activeGenres.toSorted().join(",")}`;

  const activeDeferredGameIds = deferredQueue.setupKey === setupKey ? deferredQueue.gameIds : EMPTY_GAME_IDS;
  const remoteSetup:VaultSetup = {session:activeSession,mood:activeMood,goal:activeGoal,
    collectionId:activeCollectionId === "all" ? null : activeCollectionId,genres:activeGenres,globalFilters,deferredIds:activeDeferredGameIds};
  const remoteVault = useV2Vault(v2,remoteSetup,libraryDataVersion,rememberLibraryGames);
  const collectionCounts = v2 ? remoteVault.preview?.collectionCounts ?? {} : legacyCollectionCounts;
  const legacyFullPool = useMemo(
    () => {
      if (v2 || (drawMode === "collection" && !activeCollectionId)) return [];
      return buildVaultPool({
        games: ownedGames,
        session: activeSession,
        mood: activeMood,
        goal: activeGoal,
        selectedCollectionId: activeCollectionId,
        selectedGenres: activeGenres,
        snoozedIds,
        genrePreferences,
        genrePreferenceGlobals,
        gameVerdicts: gamePreferences
      });
    },
    [v2, activeCollectionId, activeGenres, activeGoal, activeMood, activeSession, drawMode, gamePreferences, genrePreferences, genrePreferenceGlobals, ownedGames, snoozedIds]
  );
  const quickPool = useMemo(
    () => v2 ? [] : buildVaultPool({
      games: ownedGames,
      session: null,
      mood: null,
      goal: null,
      selectedCollectionId: null,
      selectedGenres: EMPTY_GAME_IDS,
      snoozedIds
    }),
    [v2, ownedGames, snoozedIds]
  );
  const fullPool = v2 ? remoteVault.preview?.deck ?? [] : legacyFullPool;
  const poolTotal = v2 ? remoteVault.preview?.poolTotal ?? 0 : fullPool.length;
  const quickTotal = v2 ? remoteVault.preview?.quickTotal ?? 0 : quickPool.length;
  const legacyDeck = useMemo(() => buildVaultDeck(legacyFullPool, activeDeferredGameIds), [activeDeferredGameIds, legacyFullPool]);
  const deck = collectionMode && !activeCollectionId ? [] : v2 ? fullPool : legacyDeck;
  // Memoised because VaultPoolPreview scrolls the rail to the winner in an effect
  // keyed on it. Found fresh each render, the effect re-ran on every state change
  // during the draw and restarted the smooth scroll each time.
  const drawWinner = useMemo(
    () => ownedGames.find((game) => game.id === drawWinnerId) ?? null,
    [ownedGames, drawWinnerId]
  );
  const legacyEligibility = useMemo(() => {
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
  const eligibility = v2 ? {stages:remoteVault.preview?.stages ?? [],games:[]} : legacyEligibility;

  useEffect(() => {
    if (!v2 || !detailsGameId) return;
    const controller = new AbortController();
    void requestJson<LibraryCard>(`/api/v2/library/${encodeURIComponent(detailsGameId)}`,{signal:controller.signal,cache:"no-store"})
      .then(card => {
        if (!controller.signal.aborted) {
          const game = libraryGame(card);
          setV2Detail(game);
          rememberLibraryGames([game]);
        }
      }).catch(() => { if (!controller.signal.aborted) setActionError("Game details could not be loaded. Please try again."); });
    return () => controller.abort();
  },[v2,detailsGameId,rememberLibraryGames,libraryDataVersion]);

  useEffect(() => {
    if (v2 && vaultState.currentPickId === revealedPickId && vaultState.currentDrawId === null && currentDrawId) {
      setCurrentDrawId(null);
      pendingDrawIdRef.current = null;
    }
  },[v2,vaultState.currentPickId,vaultState.currentDrawId,revealedPickId,currentDrawId]);

  const currentPick = ownedGames.find((game) =>
    game.id === revealedPickId &&
    game.status !== "Completed" &&
    game.status !== "Blacklisted" &&
    !snoozedIds.has(game.id)
  ) ?? null;
  // Taken from the draw that produced this pick rather than recomputed, so the
  // card keeps describing the draw it belongs to however the setup is edited
  // afterwards. The id guard covers the pick changing out from under it - being
  // slept or snoozed - which leaves the snapshot describing a game that is no
  // longer on screen.
  const pickDraw = drawSnapshot && currentPick && drawSnapshot.pickId === currentPick.id ? drawSnapshot : null;

  const detailsGame = v2 ? v2Detail?.id === detailsGameId ? v2Detail : null : ownedGames.find((game) => game.id === detailsGameId)
    ?? allGames.find((game) => game.id === detailsGameId)
    ?? null;
  const canDraw = collectionMode
    ? Boolean(collectionDraw && deck.length > 0)
    : Boolean(session && mood && goal && deck.length > 0);
  const sessionLabel = vaultSessionOptions.find((option) => option.id === session)?.label ?? null;
  const moodLabel = vaultMoodOptions.find((option) => option.id === mood)?.label ?? null;
  const goalLabel = vaultGoalOptions.find((option) => option.id === goal)?.label ?? null;
  const nextSetupStep: VaultSetupStep | null = !session ? "session" : !mood ? "mood" : !goal ? "goal" : null;
  const drawButtonLabel = drawState === "focusing" || drawState === "revealing"
    ? "Drawing from the Vault…"
    : v2 && remoteVault.pending ? "Loading Vault…"
    : v2 && remoteVault.error ? "Vault unavailable"
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
            : "Draw from Vault";
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

  const closeGuestSignInPrompt = useCallback(() => setGuestSignInOpen(false), [setGuestSignInOpen]);

  // Match the landing preview: centre the qualitative match label after reveal.
  // Rerolls and Blacklist replacements keep their existing stable scroll position.
  useEffect(() => {
    if (drawState !== "revealed" || !revealedPickId || !scrollToDrawRef.current) return;
    const target = resultRef.current;
    if (!target) return;
    const frame = requestAnimationFrame(() => {
      target.focus({ preventScroll: true });
      const anchor = target.querySelector<HTMLElement>('section[aria-label="Why this is a good match"] header [data-strength]')
        ?? target.querySelector<HTMLElement>('[data-action="steam"]');
      if (!anchor) return;
      let top = 0;
      let element: HTMLElement | null = anchor;
      while (element) {
        top += element.offsetTop;
        element = element.offsetParent as HTMLElement | null;
      }
      window.scrollTo({
        top: Math.max(0, top + anchor.offsetHeight / 2 - window.innerHeight / 2),
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"
      });
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
  const deckEmptyUnexpectedly = setupComplete && !deck.length && !(v2 && (remoteVault.pending || remoteVault.error));
  useEffect(() => {
    // Only into a strip nothing else is using, and only when the answer changes,
    // so closing it stays closed.
    if (deckEmptyUnexpectedly) setDeckPanel((current) => current ?? "lens");
  }, [deckEmptyUnexpectedly]);

  async function handleV2Draw({deferCurrentPick=false,quick=false,scrollToDraw=true,excludeGameId}:{deferCurrentPick?:boolean;quick?:boolean;scrollToDraw?:boolean;excludeGameId?:string}) {
    if (drawingRef.current || (!quick && !canDraw) || (quick && !quickTotal)) return;
    const previous = currentPick;
    if (previous && !excludeGameId) trackEvent(ANALYTICS_EVENTS.vaultPickAnother,{
      ...drawEventAnalytics(),draw_id:currentDrawId,game_id:previous.id,steam_app_id:previous.steamAppId,
    });
    if (deferCurrentPick) { recordPickEvent("drew_again",drawEventAnalytics()); setRerollCount(count => count+1); }
    else { setRerollCount(0);setRerollReasonGiven(false); }
    let deferred = activeDeferredGameIds;
    if (!quick && deferCurrentPick && previous) {
      deferred = [...deferred.filter(id => id !== previous.id),previous.id];
      const queue = {setupKey,gameIds:deferred};
      deferredQueueRef.current = queue;setDeferredQueue(queue);
    }
    const arm:GenreLearningArm = quick || collectionDraw ? "control" : nextArm(remoteVault.preview?.preferenceRowCount ?? 0);
    const activeDraw = ++activeDrawRef.current;
    drawingRef.current = true;scrollToDrawRef.current = scrollToDraw;
    setActionError("");setHighlightedGameId(null);setDrawState("focusing");setDrawMessage("Opening the Vault.");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    try {
      const request = { ...remoteSetup,deferredIds:deferred,requestKey:crypto.randomUUID(),quick,arm,
        previousId:previous?.id ?? null,cycleIds:[...drawnCycleRef.current],
        excludeIds:[...new Set([...(excludeGameId ? [excludeGameId] : []),...pendingBlacklistIdsRef.current])],
      };
      const record = drawV2Vault(request);
      // Start recording under the animation and scroll, keeping the existing
      // reveal order. V2's returned pick is selected and persisted by the server.
      const settled = record.then(value => ({ok:true as const,value}),error => ({ok:false as const,error}));
      if (scrollToDraw) await scrollToDrawStage(drawStageRef.current,reducedMotion);
      const [outcome] = await Promise.all([settled,wait(reducedMotion ? 80 : 480)]);
      if (!outcome.ok) throw outcome.error;
      if (activeDraw !== activeDrawRef.current) return;
      const result:VaultDrawResult = outcome.value;
      if (result.cycleReset) drawnCycleRef.current.clear();
      drawnCycleRef.current.add(result.game.id);
      setDrawWinnerId(result.game.id);setDrawState("revealing");
      await wait(reducedMotion ? 100 : 370);
      if (activeDraw !== activeDrawRef.current) return;
      drawRerollIndexRef.current = result.draw.rerollIndex;
      pendingDrawIdRef.current = Promise.resolve(result.draw.id);
      setDrawArm(result.arm);setCurrentDrawId(result.draw.id);
      setHighlightedGameId(result.game.id);setRevealedPickId(result.game.id);
      setDrawSnapshot({pickId:result.game.id,description:result.game.description,quick,explanation:result.explanation,reasons:result.reasons,
        collectionDraw:!quick && Boolean(result.draw.collectionId),collectionName:result.collectionName,
        session:result.draw.session,mood:result.draw.mood,goal:result.draw.goal,genres:result.draw.selectedGenres});
      setDrawState("revealed");setDrawMessage(`Vault opened. ${result.game.title} selected.`);
      trackEvent(ANALYTICS_EVENTS.vaultDrawRequested,{draw_mode:quick?"quick":collectionMode?"collection":"vault",
        session:result.draw.session,mood:result.draw.mood,goal:result.draw.goal,
        collection_selected:Boolean(result.draw.collectionId),genre_count:result.draw.selectedGenres.length,
        pool_size:result.draw.eligiblePoolCount,deck_size:result.deckSize,reroll_index:result.draw.rerollIndex,
        vault_genre_learning:result.arm,preference_rows:remoteVault.preview?.preferenceRowCount ?? 0});
    } catch (error) {
      if (activeDraw !== activeDrawRef.current) return;
      setDrawState("error");setDrawMessage("The Vault could not complete the draw. Please try again.");
      setActionError("Your draw could not be saved. Please try again.");
      trackEvent(ANALYTICS_EVENTS.vaultDrawFailed,{draw_mode:quick?"quick":collectionMode?"collection":"vault",reason:error instanceof Error?error.message:"unknown"});
    } finally { if (activeDraw === activeDrawRef.current) drawingRef.current=false; }
  }

  function recordPickEvent(event: VaultDrawEventType, properties: Record<string, unknown>, pending = pendingDrawIdRef.current) {
    if (!pending) return;
    void pending.then((id) => id ? recordDrawEvent(id, event, properties) : undefined).catch(() => {});
  }

  async function handleOpenVault({ deferCurrentPick = false, quick = false, scrollToDraw = true, excludeGameId }: { deferCurrentPick?: boolean; quick?: boolean; scrollToDraw?: boolean; excludeGameId?: string } = {}) {
    // Whatever was open under the bar closes as the draw starts.
    //
    // Vault Lens and Draw History sit directly below the draw button and cover
    // the card the result appears in. Opening one and then drawing looked like
    // the button had done nothing at all - the page had not visibly changed -
    // and people pressed it again. On a phone, where the panel is most of the
    // screen, that is nearly every draw.
    //
    // The deck-empty effect can reopen the Lens straight afterwards, which is
    // correct: that is the one case where there is something to explain.
    setDeckPanel(null);
    if (v2) return handleV2Draw({deferCurrentPick,quick,scrollToDraw,excludeGameId});

    // Quick Draw bypasses the setup gate on purpose: it exists for the visitor who
    // has not filled anything in and wants a game anyway.
    if (drawingRef.current || (!quick && !canDraw)) return;
    if (quick && !quickPool.length) return;
    if (currentPick && !excludeGameId) trackEvent(ANALYTICS_EVENTS.vaultPickAnother, {
      ...drawEventAnalytics(), draw_id: currentDrawId, game_id: currentPick.id, steam_app_id: currentPick.steamAppId
    });
    if (deferCurrentPick) recordPickEvent("drew_again", drawEventAnalytics());
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
    // The optimistic blacklist may not have rendered into the memoized pool yet.
    // Use the same exclusions for selection, explanations and recorded counts.
    const drawPool = (quick ? quickPool : fullPool).filter((entry) => entry.game.id !== excludeGameId && !pendingBlacklistIdsRef.current.has(entry.game.id));
    let activeDeck = uniform ? drawPool : buildVaultDeck(drawPool, activeDeferredGameIds);
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
      if (!uniform) activeDeck = buildVaultDeck(drawPool, nextDeferredIds);
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
    if (!nextPick) {
      if (excludeGameId) {
        setRevealedPickId(null);
        setDrawSnapshot(null);
        setCurrentDrawId(null);
        pendingDrawIdRef.current = null;
        setDrawState("idle");
        setDrawMessage("No more eligible games in this draw. Change your setup or undo the Blacklist.");
      }
      return;
    }
    drawnCycleRef.current.add(nextPick.id);

    // Built from the inputs this draw is running with, captured here rather than
    // read again at render time, when they may have moved on.
    const describeDraw = (pickId: string): DrawSnapshot => {
      const explanationPool = drawPool;
      const entry = explanationPool.find((candidate) => candidate.game.id === pickId) ?? null;
      // Explained only when the draw actually reasoned: a Quick Draw ignores the
      // setup entirely and a Collection Draw drops session, mood and goal.
      // Scoring them anyway put a "Why it's a great match" panel on the card
      // headed "Eligible pick · 0/100" - a score of nothing, dressed as
      // reasoning, for a draw that reasoned about nothing.
      const guided = !quick && !collectionMode;
      return {
        pickId,
        quick,
        explanation: guided && entry
          ? buildVaultMatchExplanation({
              entry,
              pool: explanationPool,
              session: activeSession,
              mood: activeMood,
              goal: activeGoal,
              selectedGenres: activeGenres,
              includePersonalTaste: arm === "test"
            })
          : null,
        // Quick Draw picks at random from everything eligible. There is no match
        // to describe, so the card says nothing rather than reaching for
        // whatever the pool happened to note about the game.
        reasons: quick ? [] : entry?.reasons ?? [],
        collectionDraw: !quick && collectionDraw,
        collectionName: quick ? null : selectedCollection?.name ?? null,
        session: quick ? null : activeSession,
        mood: quick ? null : activeMood,
        goal: quick ? null : activeGoal,
        genres: quick ? [] : activeGenres
      };
    };

    drawingRef.current = true;
    scrollToDrawRef.current = scrollToDraw;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setDrawWinnerId(nextPick.id);
    setHighlightedGameId(null);
    setDrawMessage("Opening the Vault.");

    // Move to the pick before anything starts moving. Drawing from halfway up the
    // setup meant the animation played somewhere off-screen and the result was
    // simply there by the time you scrolled down to it. The draw bar is the
    // anchor rather than the card itself, so the button that rerolls stays in
    // view alongside whatever it just produced.
    // The result-card reroll is already where the player wants to stay.
    if (scrollToDraw) await scrollToDrawStage(drawStageRef.current, reducedMotion);
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
      eligiblePoolCount: drawPool.length,
      rerollIndex: drawnCycleRef.current.size - 1,
      // Recorded even in the control arm: the choice set is training data for a
      // future model, not part of this experiment.
      finalistAppIds: uniform ? undefined : vaultFinalists(availablePool, currentPick?.id).map((entry) => entry.game.steamAppId).filter((appId): appId is number => typeof appId === "number" && appId > 0)
    }).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    );

    // Show the pick after its animation, independently of the history write.
    // Follow-up events capture this promise so rapid rerolls keep the right draw ID.
    const pendingDrawId = record.then((outcome) => outcome.ok ? outcome.value.id : null);
    void record.then((outcome) => {
      if (!outcome.ok) trackEvent(ANALYTICS_EVENTS.vaultDrawFailed, {
        draw_mode: quick ? "quick" : collectionMode ? "collection" : "vault",
        reason: "history_write_failed"
      });
      if (activeDraw !== activeDrawRef.current) return;
      if (!outcome.ok) setActionError("Your pick is ready, but Draw History could not be saved. You can still play or draw again.");
    });

    try {
      await wait(reducedMotion ? 80 : 480);
      if (activeDraw !== activeDrawRef.current) return;
      setDrawState("revealing");
      await wait(reducedMotion ? 100 : 370);
      if (activeDraw !== activeDrawRef.current) return;

      drawRerollIndexRef.current = drawnCycleRef.current.size - 1;
      // Until the reveal, actions still belong to the previous visible pick.
      pendingDrawIdRef.current = pendingDrawId;
      setDrawArm(arm);
      setCurrentDrawId(null);
      void pendingDrawId.then((id) => {
        if (activeDraw === activeDrawRef.current) setCurrentDrawId(id);
      });
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
        pool_size: drawPool.length,
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
    setGenreFiltersOpen(false);
    if (openSetupStep !== step) revealSetupStep(step);
  }

  function selectSetupOption(step: VaultSetupStep, id: string) {
    setDrawMode("vault");
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
      setGenreFiltersOpen(false);
      revealSetupStep(nextStep);
      return;
    }

    // Advance to optional filters; only this final panel may be closed.
    setOpenSetupStep(null);
    setGenreFiltersOpen(true);
    window.requestAnimationFrame(() => document.getElementById("vault-genre-toggle")?.focus({ preventScroll: true }));
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
    await clearVaultSnoozes();
  }

  /* Toggling is a state update; fetching the history and reporting the open are
     not, so they stay out of the updater React is free to run twice. */
  function openDrawHistory() {
    if (deckPanel === "history") {
      setDeckPanel(null);
      return;
    }
    setDeckPanel("history");
    setHistoryPending(true);
    void loadVaultHistory().catch(() => setActionError("Draw History could not be loaded. Please try again.")).finally(() => setHistoryPending(false));
  }

  async function togglePin(id: string) {
    const game = ownedGames.find((item) => item.id === id) ?? allGames.find((item) => item.id === id);
    if (!game) return;
    if (vaultState.pinnedIds.includes(id)) {
      await recordVaultAction("unpinned", id);
      setPinMessage(`${game.title} removed from Playing Next.`);
      return;
    }
    if (vaultState.pinnedIds.length >= 3) {
      setPinContext({ source: "vault" });
      setPinCandidate(game);
      return;
    }
    await recordVaultAction("pinned", id);
    setPinMessage(`${game.title} added to Playing Next.`);
  }

  async function acceptPick(source: "vault_play_now" | "vault_save_later") {
    if (!currentPick || savingPick) return;
    const pendingDraw = pendingDrawIdRef.current;
    const context = { source, draw_id: currentDrawId, steam_app_id: currentPick.steamAppId, launch_target: steamPlayIsLaunch ? "steam_client" : "steam_store" };
    const properties = { ...drawEventAnalytics(), ...context, game_id: currentPick.id, launch_target: steamPlayIsLaunch ? "steam_client" : "steam_store" };
    if (source === "vault_play_now") {
      trackNavigationEvent(ANALYTICS_EVENTS.vaultPlayNow, properties);
      if (steamPlayIsLaunch) {
        recordPickEvent("opened_on_steam", properties, pendingDraw);
        if (vaultState.pinnedIds.includes(currentPick.id)) trackNavigationEvent(ANALYTICS_EVENTS.playingNextGameLaunched, properties);
      } else {
        // A store-page action expresses intent without proving the game launched.
        recordPickEvent("play_now_intent", properties, pendingDraw);
      }
    } else trackEvent(ANALYTICS_EVENTS.vaultSaveLater, properties);
    if (vaultState.pinnedIds.includes(currentPick.id)) return;
    if (vaultState.pinnedIds.length >= 3) {
      setPinContext({ ...context, draw_id: currentDrawId ?? await pendingDraw });
      setPinCandidate(currentPick);
      return;
    }
    setSavingPick(true);
    try {
      await recordVaultAction("pinned", currentPick.id, context);
      if (source === "vault_play_now" && steamPlayIsLaunch) trackNavigationEvent(ANALYTICS_EVENTS.playingNextGameLaunched, properties);
      recordPickEvent("pinned", drawEventAnalytics(), pendingDraw);
      setPinMessage(`${currentPick.title} added to Playing Next. ${source === "vault_save_later" ? "Ready whenever you are." : "Your choice is saved."}`);
    } catch {
      setPinMessage("Could not save to Playing Next. Please try again.");
    } finally {
      setSavingPick(false);
    }
  }

  const isCurrentPickPinned = currentPick ? vaultState.pinnedIds.includes(currentPick.id) : false;

  async function blacklistPoolGame(gameId: string, replacePick = false) {
    const game = ownedGames.find((item) => item.id === gameId);
    if (!game || game.status === "Completed" || game.status === "Blacklisted" || pendingBlacklistIdsRef.current.has(gameId)) return;
    const previousStatus = game.status === "In Progress" ? "In Progress" : "Not Started";
    const wasPinned = vaultState.pinnedIds.includes(gameId);
    setActionError("");
    setPinMessage("");
    setCompletionUndo(null);
    pendingBlacklistIdsRef.current.add(gameId);
    setBlacklistUndo({ gameId, title: game.title, status: previousStatus, wasPinned });
    const write = updateGame(gameId, { status: "Blacklisted" });
    blacklistWritesRef.current.set(gameId, write);
    if (replacePick) void handleOpenVault({ quick: pickDraw?.quick ?? !canDraw, scrollToDraw: false, excludeGameId: gameId });
    try {
      const receipt=await write;
      if (receipt) setBlacklistUndo(current => current?.gameId===gameId ? {...current,receipt} : current);
    } catch {
      setBlacklistUndo((current) => current?.gameId === gameId ? null : current);
      setActionError(`Could not blacklist ${game.title}. Your library is being refreshed; please try again.`);
    } finally {
      pendingBlacklistIdsRef.current.delete(gameId);
      blacklistWritesRef.current.delete(gameId);
    }
  }

  async function undoBlacklist() {
    if (!blacklistUndo || undoingBlacklistRef.current) return;
    const undo = blacklistUndo;
    undoingBlacklistRef.current = true;
    setBlacklistUndo(null);
    setActionError("");
    try {
      // Undo must follow persistence, even when clicked before Blacklist saves.
      const receipt=await blacklistWritesRef.current.get(undo.gameId) ?? undo.receipt;
      await updateGame(undo.gameId, { status: undo.status,completedAt:null },{action:"undo",...(v2?{expected_version:receipt?.mutationVersion}:{})});
      if (undo.wasPinned) {
        if (vaultState.pinnedIds.length < 3) await recordVaultAction("pinned", undo.gameId);
        else setActionError(`${undo.title} is restored. Playing Next is full, so add it again when a slot is free.`);
      }
      drawnCycleRef.current.delete(undo.gameId);
    } catch {
      setActionError(`Could not finish restoring ${undo.title}. Check its status in your library and try again.`);
    } finally {
      undoingBlacklistRef.current = false;
    }
  }

  async function completeGame(game: DemoGame) {
    const receipt=await updateGame(game.id, { status: "Completed" },{surface:"vault"});
    trackCompletionClaim(game, "vault", isLive && !v2);
    setHighlightedGameId(null);
    setCompletionUndo({ id: game.id, title: game.title,previous:game,...(receipt?{receipt}:{}) });
  }

  async function undoCompletion() {
    if (!completionUndo) return;
    const gameId = completionUndo.id;
    const game = ownedGames.find((entry) => entry.id === gameId);
    setCompletionUndo(null);
    if (v2) await updateGame(gameId,{status:completionUndo.previous.status,completedAt:completionUndo.previous.completedAt ?? null},
      {action:"undo",expected_version:completionUndo.receipt?.mutationVersion});
    else await restoreGame(gameId);
    if (game) trackCompletionUndone(game, "vault", isLive && !v2);
  }

  function openGameDetails(gameId: string, surface: VaultDetailsSurface) {
    setDetailsGameId(gameId);
    setDetailsSurface(surface);
  }

  function closeGameDetails() {
    setV2Detail(null);
    setDetailsGameId(null);
    setDetailsSurface(null);
  }

  return (
    <section className={styles.vaultPage} data-vault-controls="standard">
      <h1 className="visually-hidden">Vault</h1>


      <PinnedCommitments
          games={ownedGames}
          pins={vaultState.pins ?? []}
          pinnedIds={vaultState.pinnedIds}
          onSelect={(gameId) => openGameDetails(gameId, "pinned")}
          onUnpin={(gameId) => { void recordVaultAction("unpinned", gameId).catch(() => {}); }}
          compact
        />

      {!isLive ? (
        <GuestPreviewNotice feature="Vault" icon="current-pick">
          Draw from {ownedGames.length} popular Steam games or try a catalogue collection. Your picks and history last for this visit only.
        </GuestPreviewNotice>
      ) : null}

      <section className={styles.setupLayout} aria-label="Vault draw setup" data-paused={collectionMode || undefined}>
        <div className={styles.optionStack}>
          <VaultOptionGroup variant="compact" title="Session" stepNumber={1} options={vaultSessionOptions} selectedId={session} selectedLabel={sessionLabel} expanded={openSetupStep === "session"} state={session ? "complete" : openSetupStep === "session" ? "active" : "pending"} onToggle={() => focusSetupStep("session")} onSelect={(id) => selectSetupOption("session", id)} />
          <VaultOptionGroup variant="compact" title="Mood" stepNumber={2} options={vaultMoodOptions} selectedId={mood} selectedLabel={moodLabel} expanded={openSetupStep === "mood"} state={mood ? "complete" : openSetupStep === "mood" ? "active" : "pending"} onToggle={() => focusSetupStep("mood")} onSelect={(id) => selectSetupOption("mood", id)} />
          <VaultOptionGroup variant="compact" title="Goal" stepNumber={3} options={vaultGoalOptions} selectedId={goal} selectedLabel={goalLabel} expanded={openSetupStep === "goal"} state={goal ? "complete" : openSetupStep === "goal" ? "active" : "pending"} onToggle={() => focusSetupStep("goal")} onSelect={(id) => selectSetupOption("goal", id)} lockedOptionIds={isLive ? [] : ["finish"]} onLockedSelect={() => setGuestSignInOpen(true)} />
        </div>

        <div className={styles.setupSidebar}>
          {/* Optional filters stay available without interrupting the required choices. */}
          <aside
            className={styles.optionalSetup}
            aria-label="Optional genre filters"
            data-disabled={collectionMode || undefined}
          >
            <button
              type="button"
              data-vault-control="disclosure" className={styles.optionalHeader}
              aria-expanded={genreFiltersOpen}
              id="vault-genre-toggle"
              aria-controls="vault-genre-filters"
              onClick={() => {
                setGenreFiltersOpen((current) => !current);
                if (!nextSetupStep) setOpenSetupStep(null);
              }}
            >
              <span className={styles.optionalIcon}><VaultIcon name="filter" size={21} /></span>
              <span className={styles.optionalCopy}><strong>Genre filters</strong><small>{collectionMode ? "Vault Draw only · collection mode ignores filters" : selectedGenres.length ? `${selectedGenres.length} of 3 selected` : !nextSetupStep ? "Optional · narrow the deck by genre" : "Optional · no filters selected"}</small></span>
              <span className={styles.optionalLabel}>{collectionMode ? "Paused" : "Optional"}</span>
              <VaultIcon className={styles.optionalChevron} name="chevron-down" size={17} />
            </button>
            {genreFiltersOpen ? (
              <div className={styles.optionalContent} id="vault-genre-filters">
                <div className={styles.genreSetup}>
                  <VaultGenrePanel selectedGenres={selectedGenres} onToggleGenre={toggleGenre} onClear={clearGenres} embedded disabled={collectionMode} isGuest={!isLive} />
                </div>
              </div>
            ) : null}
          </aside>
        </div>
      </section>

      <section ref={drawStageRef} className={styles.drawActionBar} aria-label="Vault draw status" data-mode={drawMode}>
        <div className={styles.drawModePicker}>
          <div className={styles.drawModeToggle} role="tablist" aria-label="Draw type">
            <button type="button" data-vault-control="selection" data-control-hover="secondary" data-control-indicator="bar" role="tab" aria-selected={!collectionMode} className={styles.drawModeButton} data-active={!collectionMode || undefined} onClick={() => setDrawMode("vault")}><VaultIcon name="draw-from-vault" size={17} />Vault Draw</button>
            <button type="button" data-vault-control="selection" data-control-hover="secondary" data-control-indicator="bar" role="tab" aria-selected={collectionMode} className={styles.drawModeButton} data-active={collectionMode || undefined} onClick={activateCollectionDraw}><VaultIcon name="collections" size={17} />Collection Draw</button>
          </div>
          {/* The picker is only the question "which collection", so it only asks
              once Collection Draw is the mode. It used to sit here permanently
              as a second, differently worded way to switch modes. */}
          {collectionMode && entireVault ? (
            <VaultCollectionCard
              triggerId="vault-collection-picker-trigger"
              selectedCollection={selectedCollection ?? entireVault}
              collections={collections}
              collectionCounts={collectionCounts}
              onSelect={selectDrawCollection}
              selectionActive={collectionDraw}
              allowEntireVault={false}
            />
          ) : collectionMode ? <p>No collections yet. <Link href="/collections" data-vault-control="text">Create a collection</Link> to draw from it.</p> : null}
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
            data-vault-control="secondary" className={styles.deckToolButton}
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
            data-vault-control="secondary" className={styles.deckToolButton}
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
          <button type="button" ref={drawButtonRef} data-vault-control="primary" className={styles.ctaButton} onClick={handlePrimaryDrawAction} disabled={isDrawing || (v2 && (remoteVault.pending || Boolean(remoteVault.error))) || (collectionMode ? Boolean(selectedCollection && !deck.length) : (!nextSetupStep && !deck.length))} aria-busy={isDrawing || (v2 && remoteVault.pending)} aria-describedby="vault-setup-status">
            {isDrawing ? <span data-control-spinner aria-hidden="true" /> : <VaultIcon name="draw-from-vault" size={22} />}{drawButtonLabel}
          </button>
          <button type="button" data-vault-control="secondary" className={styles.quickDrawButton} onClick={() => void handleOpenVault({ quick: true })} disabled={isDrawing || !quickTotal}>
            <VaultIcon name="shuffle" size={16} />Roll the dice
          </button>
        </div>
      </section>

      {v2 && remoteVault.error ? <p role="alert">{remoteVault.error} <button type="button" data-vault-control="tertiary" onClick={remoteVault.retry}>Retry</button></p> : null}

      {/* Directly under the bar, so a panel opens next to the button that
          toggles it rather than somewhere further down the page. */}
      {deckPanel === "lens" ? <VaultLens pickExplanation={pickDraw?.explanation} pickTitle={currentPick?.title} stages={eligibility.stages} selectedCollection={collectionDraw} selectedGenres={Boolean(activeGenres.length)} snoozedCount={snoozedIds.size} onClearGenres={clearGenres} onUseEntireVault={() => setDrawMode("vault")} onClearSnoozes={() => void clearSnoozes().catch(() => {})} /> : null}
      {deckPanel === "history" ? (
        <VaultHistoryPanel
          draws={vaultHistory}
          games={v2 ? allGames : ownedGames}
          isLive={isLive}
          loading={historyPending}
          onClear={clearVaultHistory}
          onViewDetails={(game) => {
            setDeckPanel(null);
            openGameDetails(game.id, "history");
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
          tabIndex={-1}
          className={`${styles.resultCard} ${drawState === "revealed" ? styles.resultRevealed : ""}`}
          data-visible={drawState === "revealed"}
          data-drawing={isDrawing || undefined}
        >
          {/* Artwork and the name sit side by side rather than stacked, so the
              description fills the room beside the image instead of the card
              spending a whole band on each in turn. */}
          <div className={styles.resultTop}>
            <div data-vault-card="surface" className={styles.resultArtwork}>
              <Artwork src={currentPick.bannerUrl} sizes="(max-width: 820px) 100vw, 36vw" priority fit="cover" />
              <FamilyGameMark game={currentPick} overlay />
            </div>
            <div className={styles.resultIntro}>
              {/* Beside the name rather than over the artwork, where it was covering the
                  part of the header art the game chose to put its title on. */}
              <div className={styles.resultHeading}>
                <h2 className={styles.resultTitle}>{currentPick.title}</h2>
                <VaultIcon name="new" size={22} />
                <span className={styles.currentPickBadge}><VaultIcon name="current-pick" size={16} />Current pick</span>
              </div>
              <p className={styles.resultCopy}>{pickDraw?.description ?? currentPick.description}</p>
              <FilteredSteamDeckBadge category={currentPick.deckCompatibility} />
              {/* Sat on the summary bar until it ran out of room and truncated
                  to "ESTIMATED PLAYTHROUG". It reads better next to the game it
                  describes, in space that was going spare. */}
              {formatGameDuration(currentPick.duration) ? (
                <p className={styles.resultDuration}>
                  <VaultIcon name="clock" size={15} />
                  {formatGameDuration(currentPick.duration)}
                  {!playtimeIsUnknown(currentPick) && currentPick.hoursPlayed > 0 ? <span>· {currentPick.hoursPlayed}h played</span> : null}
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
            {currentDrawId && rerollCount >= 3 && !rerollReasonGiven ? <div className={styles.rerollAsk}>
              <span className={styles.feedbackLabel}>Nothing landing. What&apos;s off?</span>
              <div className={styles.rerollReasons}>
                {VAULT_REROLL_REASONS.map((reason) => (
                  <button
                    key={reason.id}
                    type="button"
                    data-vault-control="secondary" className={styles.feedbackButton}
                    onClick={() => { setRerollReasonGiven(true); void recordDrawEvent(currentDrawId, reason.id, drawEventAnalytics()); }}
                  >{reason.label}</button>
                ))}
              </div>
            </div> : null}

            <div className={styles.resultActions}>
              <a href={steamPlayIsLaunch ? steamLaunchUrl(currentPick.steamAppId) : steamStoreUrl(currentPick.steamAppId)} target={steamPlayIsLaunch ? undefined : "_blank"} rel={steamPlayIsLaunch ? undefined : "noreferrer"} className={`${styles.resultAction} ${styles.resultActionPrimary}`} data-vault-control="steam" data-action="steam" onClick={() => { void acceptPick("vault_play_now"); }}>
                <VaultResultActionIcon name="open-steam" />
                <span className={styles.resultActionCopy}>
                  <strong>{steamPlayIsLaunch ? "Play now" : "View on Steam"}</strong>
                  <small>{steamPlayIsLaunch ? "Launch in the Steam client" : "Open the Steam store page"}</small>
                </span>
              </a>
              {isCurrentPickPinned ? <div className={styles.resultAction} data-action="pin" data-pinned="true" role="status">
                <VaultIcon name="check" size={24} />
                <span className={styles.resultActionCopy}><strong>Playing Next</strong><small>Your choice is saved</small></span>
              </div> : <button type="button" className={styles.resultAction} data-vault-control="play-later" data-action="pin" aria-busy={savingPick} disabled={savingPick} onClick={() => { void acceptPick("vault_save_later"); }}>
                <span className={styles.resultActionIcon} aria-hidden="true">{savingPick ? <span data-control-spinner /> : <ActionIcon kind="next" />}</span>
                <span className={styles.resultActionCopy}><strong>{savingPick ? "Saving…" : "Save for later"}</strong><small>Add to Playing Next</small></span>
              </button>}
              <button type="button" className={`${styles.resultAction} ${styles.pickAnother}`} data-vault-control="primary" data-action="draw" aria-busy={isDrawing} disabled={isDrawing || (!canDraw && !quickTotal)} onClick={() => void handleOpenVault({ deferCurrentPick: true, quick: pickDraw?.quick ?? !canDraw, scrollToDraw: false })}>
                {isDrawing ? <span data-control-spinner aria-hidden="true" /> : <VaultIcon name="draw-from-vault" size={28} />}
                <span className={styles.resultActionCopy}><strong>{isDrawing ? "Drawing…" : "Reroll"}</strong><small>Pick another game</small></span>
              </button>
              <button type="button" className={styles.resultAction} data-vault-control="blacklist" data-action="blacklist" disabled={isDrawing} onClick={() => void blacklistPoolGame(currentPick.id, true)}>
                <span className={styles.resultActionIcon} aria-hidden="true"><ActionIcon kind="blacklist" /></span>
                <span className={styles.resultActionCopy}><strong>Blacklist</strong><small>Stop offering this game</small></span>
              </button>
            </div>
          </div>
          <aside className={styles.resultContext} aria-label="Selected setup">
            {pickDraw?.quick ? <>
              <ResultSummary icon="goal" label="Quick Draw" value="Any eligible game" />
              <ResultSummary icon="genre" label="Setup" value="Not used" />
            </> : pickDraw?.collectionDraw ? <>
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
            meta={v2 && remoteVault.pending ? "Loading…" : `${deck.length}${poolTotal > deck.length ? ` of ${poolTotal}` : ""} matches`}
          />
          <p className={styles.poolDescription}>Strongest current candidates based on your filters, mood and goal.</p>


          {/* The setup pills that used to sit here restated session, mood and goal,
              which the pick's own summary bar shows directly above. What is worth
              keeping is the case where the deck is empty and the reason why. */}
          {collectionMode && !selectedCollection ? <span className={styles.noFilters}>Choose a collection to build this deck.</span> : null}
        </div>

        {v2 && remoteVault.pending ? <VaultShuffleLoader active inline label="Loading your Vault" /> : v2 && remoteVault.error ? <p role="status">Your Vault is temporarily unavailable.</p> : deck.length ? (
          <VaultPoolPreview
            entries={deck}
            drawState={drawState}
            winner={drawWinner}
            highlightedId={highlightedGameId}
            onSelect={(gameId) => openGameDetails(gameId, "pool")}
            onUserScroll={() => setHighlightedGameId(null)}
          />
        ) : (
          <div className={styles.emptyState}>
            <h3 className={styles.emptyTitle}>{collectionMode ? selectedCollection ? "No active games in this collection." : "Choose a collection to build this deck." : "No games matched that combination."}</h3>
            <p className={styles.emptyCopy}>{collectionMode ? selectedCollection ? "Try another collection or switch back to Vault Draw." : "Collection Draw uses every active game in the collection, without extra filters." : "Try loosening the genre filters or switch to Surprise Me for a wider pool."}</p>
            {collectionMode ? <button type="button" data-vault-control="secondary" className={styles.secondaryAction} onClick={() => setDrawMode("vault")}>Use Vault Draw</button> : <button type="button" data-vault-control="secondary" className={styles.secondaryAction} onClick={clearGenres}>Clear genre filters</button>}
          </div>
        )}

      </section>

      {/* Pin props matter here: without them the drawer's pin button renders
          disabled, so opening a deck card and trying to pin it did nothing. */}
      <LibraryDetailsDrawer
        game={detailsGame}
        previewMode={!isLive}
        variant={detailsSurface === "pinned" ? "pinned" : "library"}
        pin={(vaultState.pins ?? []).find((entry) => entry.gameId === detailsGame?.id)}
        collections={collections}
        saving={savingGameId === detailsGame?.id}
        pinSlot={detailsGame ? vaultState.pinnedIds.indexOf(detailsGame.id) + 1 || null : null}
        pinCount={vaultState.pinnedIds.length}
        onTogglePin={() => {
          if (!detailsGame) return;
          const removingSpotlight = detailsSurface === "pinned" && vaultState.pinnedIds.includes(detailsGame.id);
          void togglePin(detailsGame.id).then(() => { if (removingSpotlight) closeGameDetails(); }).catch(() => {});
        }}
        onManagePins={() => { if (detailsGame) { setPinContext({ source: "vault" }); setPinCandidate(detailsGame); } }}
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
        onClose={closeGameDetails}
        onComplete={() => detailsGame ? completeGame(detailsGame) : Promise.resolve()}
        onBlacklist={() => detailsGame ? blacklistPoolGame(detailsGame.id) : Promise.resolve()}
        onRestore={async () => { if (detailsGame) await restoreGame(detailsGame.id); }}
      />
      <GuestSignInPrompt open={guestSignInOpen} onClose={closeGuestSignInPrompt} catalogueSize={ownedGames.length} reason="finish_goal" />
      <div className={styles.toastStack}>
      {actionError ? <div className={styles.pinToast} role="alert">{actionError}<button type="button" data-vault-control="tertiary" onClick={() => setActionError("")}>Dismiss</button></div> : null}
      {blacklistUndo ? <div className={styles.sleepToast} role="status"><span>{blacklistUndo.title} is blacklisted{blacklistUndo.wasPinned ? " and was removed from Playing Next" : " and will stay out of Vault draws"}.</span><button type="button" data-vault-control="tertiary" onClick={() => void undoBlacklist().catch(() => {})}>Undo</button></div> : null}
      {pinMessage ? <div className={styles.pinToast} role="status">{pinMessage}<button type="button" data-vault-control="tertiary" onClick={() => setPinMessage("")}>Dismiss</button></div> : null}
      {completionUndo ? <div className={styles.pinToast} role="status">{completionUndo.title} marked as completed.<button type="button" data-vault-control="tertiary" onClick={() => void undoCompletion().catch(() => {})}>Undo</button></div> : null}
      </div>
      {pinCandidate ? <ManagePinsDialog pinnedGames={pinnedGames} candidate={pinCandidate} onRemove={async (id) => { await recordVaultAction("unpinned", id); }} onReplace={async (replaceId) => { await recordVaultAction("pinned", pinCandidate.id, { ...pinContext, replace_game_id: replaceId }); if (pinContext.source === "vault_play_now" && pinContext.launch_target === "steam_client") trackEvent(ANALYTICS_EVENTS.playingNextGameLaunched, { ...pinContext, game_id: pinCandidate.id }); if (typeof pinContext.draw_id === "string") void recordDrawEvent(pinContext.draw_id, "pinned").catch(() => {}); setPinMessage(`${pinCandidate.title} replaced ${pinnedGames.find((game) => game.id === replaceId)?.title ?? "a Playing Next game"}.`); }} onClose={() => setPinCandidate(null)} /> : null}
    </section>
  );
}

function wait(duration: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, duration));
}

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
