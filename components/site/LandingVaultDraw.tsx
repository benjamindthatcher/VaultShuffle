"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Artwork } from "@/components/shared/Artwork";
import { ActionIcon } from "@/components/library/LibraryGameActions";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { VaultMatchReasons } from "@/components/vault/VaultMatchReasons";
import { VaultOptionGroup } from "@/components/vault/VaultOptionGroup";
import { guestFallbackGames, mapGuestGames } from "@/lib/app-view-model";
import type { DemoGame, VaultGoalId, VaultMoodId, VaultSessionId } from "@/lib/demo-data";
import { formatGameDuration } from "@/lib/game-duration";
import type { Game } from "@/lib/types";
import {
  buildVaultDeck,
  buildVaultMatchExplanation,
  buildVaultPool,
  drawQuickVaultGame,
  drawVaultGame,
  vaultGoalOptions,
  vaultMoodOptions,
  vaultSessionOptions,
  type VaultMatchExplanation
} from "@/lib/vault";
/* The real thing, not a copy of it. Reaching into the Vault's own stylesheet is
   the only way the two stay identical: a second set of rules describing the same
   accordion would be one edit away from being a different accordion. */
import vaultStyles from "@/app/(product)/vault/vault.module.css";
import styles from "./landing-vault-draw.module.css";

type SetupStep = "session" | "mood" | "goal";
type DrawState = "idle" | "focusing" | "revealing" | "revealed";

/**
 * What the draw that produced the pick on screen was set to, frozen when it ran.
 *
 * Same reasoning as the Vault's: answering a question differently afterwards must
 * not rewrite the card for a draw that already happened.
 */
type DrawSnapshot = {
  pickId: string;
  quick: boolean;
  explanation: VaultMatchExplanation | null;
  session: VaultSessionId | null;
  mood: VaultMoodId | null;
  goal: VaultGoalId | null;
};

const NO_SNOOZES: Set<string> = new Set();
const NO_GENRES: string[] = [];
const NO_DEFERRALS: string[] = [];
/**
 * The Vault's draw, running on the landing page against the bundled sample
 * library.
 *
 * The accordion and weighted draw use the Vault's components and scoring. The
 * sample library has no playtime, so Finish Something uses session and mood
 * scoring on this page. Nothing is recorded against an account.
 */
export function LandingVaultDraw() {
  const [session, setSession] = useState<VaultSessionId | null>(null);
  const [mood, setMood] = useState<VaultMoodId | null>(null);
  const [goal, setGoal] = useState<VaultGoalId | null>(null);
  const [openStep, setOpenStep] = useState<SetupStep | null>("session");
  /**
   * The draw in progress, stamped with the setup it belongs to.
   *
   * Carrying the setup key rather than resetting this when the setup changes is
   * what keeps the reset out of an effect: a run whose key no longer matches is
   * simply read as idle, and its deferred list as empty, on the next render.
   */
  const [run, setRun] = useState<{ setupKey: string; state: DrawState; deferredIds: string[] }>(
    { setupKey: "", state: "idle", deferredIds: [] }
  );
  // The game itself rather than its id. The pool is swapped out from under this
  // once the live catalogue lands, and an id looked up in the new pool is an id
  // that is no longer there - which would take the card off the screen.
  const [revealedPick, setRevealedPick] = useState<DemoGame | null>(null);
  const [isLaunching, setIsLaunching] = useState(false);
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [blacklistedIds, setBlacklistedIds] = useState<string[]>([]);
  const [blacklistUndo, setBlacklistUndo] = useState<{ id: string; title: string; wasSaved: boolean } | null>(null);
  const [emptyMessage, setEmptyMessage] = useState("");
  // Immediate exclusions also cover draws started before React commits the state.
  const blacklistedIdsRef = useRef(new Set<string>());
  const [snapshot, setSnapshot] = useState<DrawSnapshot | null>(null);
  const [drawMessage, setDrawMessage] = useState("");
  /**
   * The preview library: the bundled pool until the live catalogue arrives.
   *
   * Both are guest pools in the sense the Vault means it - popular Steam games
   * with no playtime attached - so the draw behaves the same either way and a
   * catalogue that never loads costs variety, not correctness.
   */
  const [games, setGames] = useState<DemoGame[]>(guestFallbackGames);

  const drawingRef = useRef(false);
  const activeDrawRef = useRef(0);
  const drawnCycleRef = useRef<Set<string>>(new Set());
  const resultRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const drawButtonRef = useRef<HTMLButtonElement>(null);
  /** The one in-flight request, so every trigger after the first joins it. */
  const poolRequestRef = useRef<Promise<DemoGame[] | null> | null>(null);

  /**
   * Fetch the guest catalogue: the same thousand-game pool /vault previews with.
   *
   * Not on mount. It is a megabyte and a half of JSON, and this is the marketing
   * page, where most visits never reach the demo at all. It loads when the
   * section comes within a screen of the viewport, or the moment anyone touches
   * the setup - whichever happens first. Two triggers rather than one because
   * the observer is the efficient path and the interaction is the certain one:
   * a backgrounded tab delivers no intersections, and the pool has to be the
   * real one by the time somebody actually draws from it.
   *
   * Failure is survivable on its own: the bundled pool is already on screen, and
   * it is a guest pool too, so nothing downstream behaves differently.
   */
  const primePool = useCallback(() => {
    poolRequestRef.current ??= (async () => {
      try {
        const response = await fetch("/guest-catalogue");
        if (!response.ok) return null;
        const payload = (await response.json()) as { games?: Game[] };
        const mapped = mapGuestGames(payload.games ?? []);
        if (!mapped.length) return null;
        setGames(mapped);
        return mapped;
      } catch {
        /* The bundled preview stays. Nothing here is worth an error for. */
        return null;
      }
    })();
    return poolRequestRef.current;
  }, []);

  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void primePool();
      },
      { rootMargin: "800px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [primePool]);

  // Deliberately only the three answers. Putting the library in here meant the
  // catalogue landing counted as a setup change, and the effect below cancelled
  // the draw that was waiting on that very load. A swapped pool needs no reset:
  // deferred ids it does not contain are dropped when the deck is built, and a
  // spent-cycle id it does not contain excludes nothing.
  const setupKey = previewSetupKey(session, mood, goal);

  const eligibleGames = useMemo(() => games.filter((game) => !blacklistedIds.includes(game.id)), [games, blacklistedIds]);
  const pool = useMemo(() => buildPreviewPool(eligibleGames, session, mood, goal), [eligibleGames, goal, mood, session]);
  // No setup at all, which is what "Roll the dice" draws from.
  const quickPool = useMemo(() => buildPreviewPool(eligibleGames, null, null, null), [eligibleGames]);
  const deferredIds = run.setupKey === setupKey ? run.deferredIds : NO_DEFERRALS;
  const deck = useMemo(() => buildVaultDeck(pool, deferredIds), [deferredIds, pool]);
  // A draw that has landed stays on screen whatever the setup does next; one
  // still running belonged to a deck that no longer exists, so it reads as idle
  // and its own abort check drops it at the next step.
  const drawState: DrawState = run.state === "revealed" || run.setupKey === setupKey ? run.state : "idle";

  // A new setup is a new deck, so the draw cycle starts over. Refs only: the
  // state this used to reset is derived above instead.
  useEffect(() => {
    activeDrawRef.current += 1;
    drawingRef.current = false;
    drawnCycleRef.current.clear();
  }, [setupKey]);

  const currentPick = revealedPick;
  const pickDraw = snapshot && currentPick && snapshot.pickId === currentPick.id ? snapshot : null;

  const sessionLabel = vaultSessionOptions.find((option) => option.id === session)?.label ?? null;
  const moodLabel = vaultMoodOptions.find((option) => option.id === mood)?.label ?? null;
  const goalLabel = vaultGoalOptions.find((option) => option.id === goal)?.label ?? null;
  const nextStep: SetupStep | null = !session ? "session" : !mood ? "mood" : !goal ? "goal" : null;
  const isDrawing = drawState === "focusing" || drawState === "revealing";
  const canDraw = Boolean(session && mood && goal && deck.length);

  const drawButtonLabel = isDrawing
    ? "Drawing from the Vault…"
    : nextStep === "session"
      ? "Choose a session"
      : nextStep === "mood"
        ? "Choose your mood"
        : nextStep === "goal"
          ? "Choose your goal"
          : !deck.length
            ? "No matching games"
            : "Draw from Vault";
  function focusStep(step: SetupStep) {
    void primePool();
    setOpenStep(step);
    window.requestAnimationFrame(() => {
      const element = document.getElementById(`vault-setup-${step}`);
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      if (bounds.top < 96 || bounds.bottom > window.innerHeight - 96) {
        element.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
      }
      element.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    });
  }

  function selectOption(step: SetupStep, id: string) {
    void primePool();
    let following: SetupStep | null = null;

    if (step === "session") {
      setSession(id as VaultSessionId);
      following = !mood ? "mood" : !goal ? "goal" : null;
    } else if (step === "mood") {
      setMood(id as VaultMoodId);
      following = !session ? "session" : !goal ? "goal" : null;
    } else {
      setGoal(id as VaultGoalId);
      following = !session ? "session" : !mood ? "mood" : null;
    }

    if (following) {
      focusStep(following);
      return;
    }

    // All three answered, so the questions fold away and the draw is the only
    // thing left on the page to press.
    setOpenStep(null);
    window.requestAnimationFrame(() => drawButtonRef.current?.focus({ preventScroll: true }));
  }

  function openNextUnanswered() {
    focusStep(nextStep ?? "session");
  }

  async function runDraw({ quick = false }: { quick?: boolean } = {}) {
    if (drawingRef.current) return;
    if (!quick && (!session || !mood || !goal)) return;
    drawingRef.current = true;
    setEmptyMessage("");
    setDrawMessage("Opening the Vault.");
    setRun({ setupKey, state: "focusing", deferredIds });

    const activeDraw = activeDrawRef.current + 1;
    activeDrawRef.current = activeDraw;

    // Nothing is drawn from the bundled pool while the real one is on its way.
    // Normally it arrived a screen ago and this resolves immediately; on a fast
    // scroll straight to the draw it is the difference between previewing a
    // thousand games and previewing fourteen.
    const loaded = await primePool();
    if (activeDraw !== activeDrawRef.current) return;
    // The pools this render closed over describe the library it was rendered
    // with, so a load that has just landed has to be scored here instead.
    const drawGames = (loaded?.length ? loaded : games).filter((game) => !blacklistedIdsRef.current.has(game.id));
    const drawPool = buildPreviewPool(drawGames, session, mood, goal);
    const drawQuickPool = buildPreviewPool(drawGames, null, null, null);

    // Drawing over a pick is a reroll, and a rerolled pick goes to the back of the
    // whole pool rather than staying in the deck. Without that the same handful
    // of top-scoring games come round again and again.
    let nextDeferred = deferredIds;
    let activeDeck = quick
      ? drawQuickPool
      : buildVaultDeck(drawPool, nextDeferred);
    if (!quick && currentPick && drawPool.some((entry) => entry.game.id === currentPick.id)) {
      nextDeferred = [...nextDeferred.filter((id) => id !== currentPick.id), currentPick.id];
      activeDeck = buildVaultDeck(drawPool, nextDeferred);
    }

    let available = activeDeck.filter((entry) => !drawnCycleRef.current.has(entry.game.id));
    if (!available.length) {
      drawnCycleRef.current.clear();
      available = activeDeck;
    }

    const nextPick = quick
      ? drawQuickVaultGame(available, currentPick?.id)
      : drawVaultGame(available, currentPick?.id);
    if (!nextPick) {
      drawingRef.current = false;
      setRevealedPick(null);
      setSnapshot(null);
      setRun({ setupKey, state: "idle", deferredIds: nextDeferred });
      setEmptyMessage("No more eligible games in this preview. Undo the Blacklist or change your choices.");
      return;
    }
    drawnCycleRef.current.add(nextPick.id);

    // Built from what this draw ran with, not read again once it lands.
    const explanationPool = quick ? drawQuickPool : drawPool;
    const entry = explanationPool.find((candidate) => candidate.game.id === nextPick.id) ?? null;
    const drawSnapshot: DrawSnapshot = {
      pickId: nextPick.id,
      quick,
      // A quick draw ignores the setup entirely, so there is no match to explain
      // and the card says nothing rather than inventing reasoning for it.
      explanation: !quick && entry
        ? buildVaultMatchExplanation({ entry, pool: explanationPool, session, mood, goal, selectedGenres: NO_GENRES, includePersonalTaste: false })
        : null,
      session: quick ? null : session,
      mood: quick ? null : mood,
      goal: quick ? null : goal
    };

    const reducedMotion = prefersReducedMotion();
    setRun({ setupKey, state: "focusing", deferredIds: nextDeferred });

    await wait(reducedMotion ? 80 : 480);
    if (activeDraw !== activeDrawRef.current) return;
    setRun({ setupKey, state: "revealing", deferredIds: nextDeferred });
    await wait(reducedMotion ? 100 : 370);
    if (activeDraw !== activeDrawRef.current) return;

    setRevealedPick(nextPick);
    setIsLaunching(false);
    setSnapshot(drawSnapshot);
    setRun({ setupKey, state: "revealed", deferredIds: nextDeferred });
    setDrawMessage(`Vault opened. ${nextPick.title} selected.`);
    drawingRef.current = false;
  }

  function blacklistPick() {
    if (!currentPick || drawingRef.current) return;
    blacklistedIdsRef.current.add(currentPick.id);
    setBlacklistedIds([...blacklistedIdsRef.current]);
    setBlacklistUndo({ id: currentPick.id, title: currentPick.title, wasSaved: savedIds.includes(currentPick.id) });
    setSavedIds((ids) => ids.filter((id) => id !== currentPick.id));
    setRevealedPick(null);
    void runDraw({ quick: pickDraw?.quick ?? !canDraw });
  }

  function undoBlacklist() {
    if (!blacklistUndo) return;
    blacklistedIdsRef.current.delete(blacklistUndo.id);
    setBlacklistedIds([...blacklistedIdsRef.current]);
    if (blacklistUndo.wasSaved) setSavedIds((ids) => [...new Set([...ids, blacklistUndo.id])]);
    drawnCycleRef.current.delete(blacklistUndo.id);
    setDrawMessage(`${blacklistUndo.title} restored to the preview.`);
    setBlacklistUndo(null);
    setEmptyMessage("");
  }

  // Each completed draw takes the visitor to the result, even when just the
  // top of the card was already visible beneath the questions.
  useEffect(() => {
    if (drawState !== "revealed") return;
    const target = resultRef.current;
    if (!target) return;
    const frame = requestAnimationFrame(() => {
      target.focus({ preventScroll: true });
      // Centre the match rating, ignoring the reveal animation. Quick picks
      // have no rating, so keep their Play now button as the fallback.
      const scrollTarget = target.querySelector<HTMLElement>('section[aria-label="Why this is a good match"] header [data-strength]')
        ?? target.querySelector<HTMLButtonElement>('[data-vault-control="steam"]');
      if (!scrollTarget) return;
      let targetTop = 0;
      let element: HTMLElement | null = scrollTarget;
      while (element) {
        targetTop += element.offsetTop;
        element = element.offsetParent as HTMLElement | null;
      }
      window.scrollTo({
        top: Math.max(0, targetTop + scrollTarget.offsetHeight / 2 - window.innerHeight / 2),
        behavior: prefersReducedMotion() ? "instant" : "smooth"
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [drawState, revealedPick]);

  const duration = currentPick ? formatGameDuration(currentPick.duration) : null;

  return (
    <div className={styles.stage} ref={stageRef}>
      <section className={vaultStyles.setupLayout} aria-label="Vault draw setup">
        <div className={vaultStyles.optionStack}>
          <VaultOptionGroup
            variant="landing"
            title="Session"
            stepNumber={1}
            options={vaultSessionOptions}
            selectedId={session}
            selectedLabel={sessionLabel}
            expanded={openStep === "session"}
            state={session ? "complete" : openStep === "session" ? "active" : "pending"}
            onToggle={() => openStep === "session" ? setOpenStep(null) : focusStep("session")}
            onSelect={(id) => selectOption("session", id)}
          />
          <VaultOptionGroup
            variant="landing"
            title="Mood"
            stepNumber={2}
            options={vaultMoodOptions}
            selectedId={mood}
            selectedLabel={moodLabel}
            expanded={openStep === "mood"}
            state={mood ? "complete" : openStep === "mood" ? "active" : "pending"}
            onToggle={() => openStep === "mood" ? setOpenStep(null) : focusStep("mood")}
            onSelect={(id) => selectOption("mood", id)}
          />
          <VaultOptionGroup
            variant="landing"
            title="Goal"
            stepNumber={3}
            options={vaultGoalOptions}
            selectedId={goal}
            selectedLabel={goalLabel}
            expanded={openStep === "goal"}
            state={goal ? "complete" : openStep === "goal" ? "active" : "pending"}
            onToggle={() => openStep === "goal" ? setOpenStep(null) : focusStep("goal")}
            onSelect={(id) => selectOption("goal", id)}
          />
        </div>
      </section>

      <section className={styles.drawBar} aria-label="Vault draw">
        <div className={vaultStyles.drawActionControl}>
          <button
            type="button"
            data-vault-control="primary" className={vaultStyles.ctaButton}
            ref={drawButtonRef}
            onClick={() => (canDraw ? void runDraw() : openNextUnanswered())}
            disabled={isDrawing || (!nextStep && !deck.length)}
            aria-busy={isDrawing}
          >
            <VaultIcon name="draw-from-vault" size={22} />{drawButtonLabel}
          </button>
          <button
            type="button"
            data-vault-control="secondary" className={vaultStyles.quickDrawButton}
            onClick={() => void runDraw({ quick: true })}
            disabled={isDrawing || !quickPool.length}
          >
            <VaultIcon name="shuffle" size={16} />Roll the dice
          </button>
        </div>
      </section>

      <p className="visually-hidden" aria-live="polite">{drawMessage}</p>
      {emptyMessage ? <p className={styles.emptyMessage} role="status">{emptyMessage}</p> : null}
      {blacklistUndo ? <div className={vaultStyles.toastStack}>
        <div className={styles.previewNotice} role="status">
          <span>{blacklistUndo.title} is blacklisted in this preview.</span>
          <button type="button" data-vault-control="tertiary" onClick={undoBlacklist}>Undo</button>
          <button type="button" data-vault-control="tertiary" aria-label="Dismiss blacklist notice" onClick={() => setBlacklistUndo(null)}>Dismiss</button>
        </div>
      </div> : null}

      {currentPick ? (
        // Keyed on the pick, so a redraw replaces the card rather than editing it
        // in place - editing changed every line on the same frame, which is the
        // flash.
        <section
          key={currentPick.id}
          ref={resultRef}
          className={`${vaultStyles.resultCard} ${drawState === "revealed" ? vaultStyles.resultRevealed : ""}`}
          tabIndex={-1}
          data-drawing={isDrawing || undefined}
          aria-label={`Your pick: ${currentPick.title}`}
        >
          <div className={vaultStyles.resultTop}>
            <div data-vault-card="surface" className={vaultStyles.resultArtwork}>
              <Artwork src={currentPick.bannerUrl} alt={currentPick.title} sizes="(max-width: 820px) 100vw, 340px" fit="cover" />
            </div>
            <div className={vaultStyles.resultIntro}>
              <div className={vaultStyles.resultHeading}>
                <h3 className={vaultStyles.resultTitle}>{currentPick.title}</h3>
                <VaultIcon name="new" size={22} />
                <span className={vaultStyles.currentPickBadge}><VaultIcon name="current-pick" size={16} />Current pick</span>
              </div>
              <p className={vaultStyles.resultCopy}>{currentPick.description}</p>
              {duration ? (
                <p className={vaultStyles.resultDuration}>
                  <VaultIcon name="clock" size={15} />
                  {duration}
                  {currentPick.hoursPlayed > 0 ? <span>· {currentPick.hoursPlayed}h played</span> : null}
                </p>
              ) : null}
            </div>
          </div>

          <div className={vaultStyles.resultBody}>
            {pickDraw?.explanation ? <VaultMatchReasons explanation={pickDraw.explanation} /> : null}
            <div className={`${vaultStyles.resultActions} ${styles.previewActions}`} role="group" aria-label="Preview recommendation actions">
              <button type="button" className={`${vaultStyles.resultAction} ${vaultStyles.resultActionPrimary}`} data-vault-control="steam" data-action="steam" aria-busy={isLaunching} disabled={isLaunching || isDrawing} onClick={() => { setIsLaunching(true); setSavedIds((ids) => [...new Set([...ids, currentPick.id])]); }}>
                <span className={vaultStyles.resultActionIcon} aria-hidden="true">{isLaunching ? <span data-control-spinner /> : <VaultIcon name="open-steam" size={48} />}</span>
                <span className={vaultStyles.resultActionCopy}>
                  <strong aria-live="polite">{isLaunching ? "Launching steam" : "Play now"}</strong>
                  <small>Steam launch preview</small>
                </span>
              </button>
              {savedIds.includes(currentPick.id) ? <div className={vaultStyles.resultAction} data-action="pin" data-pinned="true" role="status">
                <VaultIcon name="check" size={24} />
                <span className={vaultStyles.resultActionCopy}><strong>Playing Next</strong><small>Saved in this preview</small></span>
              </div> : <button type="button" className={vaultStyles.resultAction} data-vault-control="play-later" data-action="pin" disabled={isDrawing} onClick={() => setSavedIds((ids) => [...new Set([...ids, currentPick.id])])}>
                <span className={vaultStyles.resultActionIcon} aria-hidden="true"><ActionIcon kind="next" /></span>
                <span className={vaultStyles.resultActionCopy}>
                  <strong>Save for later</strong>
                  <small>Add to Playing Next</small>
                </span>
              </button>}
              <button type="button" className={vaultStyles.resultAction} data-vault-control="primary" data-action="draw" disabled={isDrawing || (pickDraw?.quick ? !quickPool.length : !canDraw)} aria-busy={isDrawing} onClick={() => void runDraw({ quick: pickDraw?.quick ?? !canDraw })}>
                <span className={vaultStyles.resultActionIcon} aria-hidden="true">{isDrawing ? <span data-control-spinner /> : <VaultIcon name="draw-from-vault" size={28} />}</span>
                <span className={vaultStyles.resultActionCopy}><strong>{isDrawing ? "Drawing…" : "Reroll"}</strong><small>Pick another game</small></span>
              </button>
              <button type="button" className={vaultStyles.resultAction} data-vault-control="blacklist" data-action="blacklist" disabled={isDrawing} onClick={blacklistPick}>
                <span className={vaultStyles.resultActionIcon} aria-hidden="true"><ActionIcon kind="blacklist" /></span>
                <span className={vaultStyles.resultActionCopy}>
                  <strong>Blacklist</strong>
                  <small>Stop offering this game</small>
                </span>
              </button>
            </div>
          </div>

          <aside className={vaultStyles.resultContext} aria-label="Selected setup">
            {pickDraw?.quick ? <>
              <ResultSummary icon="goal" label="Quick Draw" value="Any eligible game" />
              <ResultSummary icon="goal" label="Setup" value="Not used" />
            </> : <>
            <ResultSummary icon="clock" label="Session" value={vaultSessionOptions.find((option) => option.id === pickDraw?.session)?.shortLabel ?? "Not selected"} />
            <ResultSummary icon="mood" label="Mood" value={vaultMoodOptions.find((option) => option.id === pickDraw?.mood)?.label ?? "Not selected"} />
            <ResultSummary icon="goal" label="Goal" value={vaultGoalOptions.find((option) => option.id === pickDraw?.goal)?.label ?? "Not selected"} />
            </>}
          </aside>
        </section>
      ) : null}

      <p className={styles.poolNote}>
        Drawing from a preview library of {games.length} popular Steam games.{" "}
        <Link data-vault-control="text" data-control-emphasis="strong" href="/vault">Try guest mode<span aria-hidden="true"> →</span></Link> for the full preview, or connect Steam to draw from your own.
      </p>
    </div>
  );
}

function ResultSummary({ icon, label, value }: { icon: "clock" | "mood" | "goal"; label: string; value: string }) {
  return (
    <div className={vaultStyles.summaryItem}>
      <VaultIcon name={icon} size={23} />
      <span><small>{label}</small><strong>{value}</strong></span>
    </div>
  );
}

function buildPreviewPool(
  games: DemoGame[],
  session: VaultSessionId | null,
  mood: VaultMoodId | null,
  goal: VaultGoalId | null
) {
  // The homepage is a sample draw with no playtime. Let visitors try Finish
  // Something using the session and mood scores instead of returning no games.
  // The guest Vault keeps its own sign-in requirement.
  return buildVaultPool({
    games,
    session,
    mood,
    goal: goal === "finish" ? null : goal,
    selectedCollectionId: null,
    selectedGenres: NO_GENRES,
    snoozedIds: NO_SNOOZES
  });
}

function previewSetupKey(
  session: VaultSessionId | null,
  mood: VaultMoodId | null,
  goal: VaultGoalId | null
) {
  return `${session ?? ""}|${mood ?? ""}|${goal ?? ""}`;
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function wait(duration: number) {
  return new Promise((resolve) => window.setTimeout(resolve, duration));
}
