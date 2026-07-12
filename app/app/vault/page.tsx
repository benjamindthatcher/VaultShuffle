"use client";

import { useMemo, useRef, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { LibraryDetailsDrawer } from "@/components/library/LibraryDetailsDrawer";
import { FilterPill } from "@/components/shared/FilterPill";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { VaultCollectionCard } from "@/components/vault/VaultCollectionCard";
import { VaultGenrePanel } from "@/components/vault/VaultGenrePanel";
import { VaultOptionGroup } from "@/components/vault/VaultOptionGroup";
import { VaultPoolPreview } from "@/components/vault/VaultPoolPreview";
import { type VaultGoalId, type VaultMoodId, type VaultSessionId } from "@/lib/demo-data";
import {
  buildVaultPool,
  drawVaultGame,
  MAX_VAULT_GENRES,
  type VaultPoolEntry,
  vaultGoalOptions,
  vaultMoodOptions,
  vaultSessionOptions
} from "@/lib/vault";
import { steamStoreUrl } from "@/lib/steam-images";
import styles from "./vault.module.css";

type VaultDrawState = "idle" | "focusing" | "revealing" | "revealed" | "error";

export default function VaultPage() {
  const { games, collections, vaultState, recordVaultAction, updateGame, setGameCollection } = useAppData();
  const [session, setSession] = useState<VaultSessionId | null>(null);
  const [mood, setMood] = useState<VaultMoodId | null>(null);
  const [goal, setGoal] = useState<VaultGoalId | null>(null);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [highlightedGameId, setHighlightedGameId] = useState<string | null>(null);
  const [detailsGameId, setDetailsGameId] = useState<string | null>(null);
  const [savingGameId, setSavingGameId] = useState<string | null>(null);
  const [drawState, setDrawState] = useState<VaultDrawState>("idle");
  const [drawWinnerId, setDrawWinnerId] = useState<string | null>(null);
  const [drawMessage, setDrawMessage] = useState("");
  const [genreLimitMessage, setGenreLimitMessage] = useState("");
  const drawingRef = useRef(false);
  const resultRef = useRef<HTMLElement>(null);

  const ownedGames = useMemo(() => games.filter((game) => game.ownership === "Owned"), [games]);
  const snoozedIds = useMemo(() => new Set(vaultState.snoozedIds), [vaultState.snoozedIds]);
  const selectedCollection = collections.find((collection) => collection.id === selectedCollectionId) ?? null;

  const pool = useMemo(
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

  const currentPick = ownedGames.find((game) => game.id === vaultState.currentPickId) ?? null;
  const detailsGame = ownedGames.find((game) => game.id === detailsGameId) ?? null;
  const missingSetup = [!session ? "Session" : "", !mood ? "Mood" : "", !goal ? "Goal" : ""].filter(Boolean);
  const canDraw = missingSetup.length === 0 && pool.length > 0;

  async function handleOpenVault() {
    if (drawingRef.current || !canDraw) return;
    const nextPick = drawVaultGame(pool, currentPick?.id);
    if (!nextPick) return;

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

      await recordVaultAction("drawn", nextPick.id, {
        session,
        mood,
        goal,
        collection_id: selectedCollectionId,
        genres: selectedGenres
      });
      setHighlightedGameId(nextPick.id);
      setDrawState("revealed");
      setDrawMessage(`Vault opened. ${nextPick.title} selected.`);
      requestAnimationFrame(() => revealResultIfNeeded(resultRef.current, reducedMotion));
    } catch (error) {
      console.error("Vault draw failed", error);
      setDrawState("error");
      setDrawMessage("The Vault could not complete the draw. Please try again.");
    } finally {
      drawingRef.current = false;
    }
  }

  function toggleGenre(genre: string) {
    setSelectedGenres((current) => {
      if (current.includes(genre)) {
        setGenreLimitMessage("");
        return current.filter((item) => item !== genre);
      }
      if (current.length >= MAX_VAULT_GENRES) {
        setGenreLimitMessage("You can choose up to 3 genres.");
        return current;
      }
      setGenreLimitMessage("");
      return [...current, genre];
    });
  }

  function clearGenres() {
    setSelectedGenres([]);
    setGenreLimitMessage("");
  }

  async function togglePin(id: string) {
    await recordVaultAction(vaultState.pinnedIds.includes(id) ? "unpinned" : "pinned", id);
  }

  async function snoozeCurrentPick() {
    if (!currentPick) return;
    await recordVaultAction("snoozed", currentPick.id);
    setHighlightedGameId(null);
  }

  return (
    <section className={styles.vaultPage}>
      <div className={styles.heroPanel}>
        <h1 className="visually-hidden">Vault</h1>
      </div>

      <div className={styles.optionStack}>
        <VaultOptionGroup title="1. Session" options={vaultSessionOptions} selectedId={session} onSelect={(id) => setSession(id as VaultSessionId)} />
        <VaultOptionGroup title="2. Mood" options={vaultMoodOptions} selectedId={mood} onSelect={(id) => setMood(id as VaultMoodId)} />
        <VaultOptionGroup title="3. Goal" options={vaultGoalOptions} selectedId={goal} onSelect={(id) => setGoal(id as VaultGoalId)} />
      </div>

      <div className={styles.workspace}>
        <div className={styles.workspaceSidebar}>
          <VaultCollectionCard
            selectedCollection={selectedCollection}
            collections={collections}
            onSelect={(id) => setSelectedCollectionId(id)}
          />
          <VaultGenrePanel
            selectedGenres={selectedGenres}
            onToggleGenre={toggleGenre}
            onClear={clearGenres}
            limitMessage={genreLimitMessage}
          />
          <button type="button" className={styles.ctaButton} onClick={() => void handleOpenVault()} disabled={!canDraw || drawingRef.current} aria-busy={drawingRef.current} aria-describedby="vault-setup-status">
            {drawState === "focusing" || drawState === "revealing" ? "Opening the Vault…" : "Open the Vault"}
          </button>
          <p className={styles.setupStatus} id="vault-setup-status">
            {missingSetup.length ? `Choose ${formatMissingSetup(missingSetup)} to open the Vault.` : !pool.length ? "No games match this setup." : "Your setup is ready."}
          </p>
        </div>

        <section className={styles.poolSection} id="vault-pool">
        <div className={styles.poolControls}>
          <div className={styles.poolHeader}>
            <p className={styles.poolLabel}>Your Pool (Filters)</p>
            <span className={styles.matchBadge}>{pool.length} Matches</span>
          </div>

          <div className={styles.pillRow}>
            {selectedCollection ? <FilterPill label={selectedCollection.name} /> : null}
            {session ? <FilterPill label={vaultSessionOptions.find((option) => option.id === session)?.label ?? "Session"} /> : null}
            {mood ? <FilterPill label={vaultMoodOptions.find((option) => option.id === mood)?.label ?? "Mood"} /> : null}
            {goal ? <FilterPill label={vaultGoalOptions.find((option) => option.id === goal)?.label ?? "Goal"} /> : null}
            {selectedGenres.map((genre) => <FilterPill key={genre} label={genre} removable onRemove={() => toggleGenre(genre)} />)}
            {!selectedCollection && !session && !mood && !goal && !selectedGenres.length ? <span className={styles.noFilters}>No filters selected</span> : null}
          </div>
        </div>

        {pool.length ? (
          <VaultPoolPreview
            entries={pool}
            drawState={drawState}
            winner={ownedGames.find((game) => game.id === drawWinnerId) ?? null}
            highlightedId={highlightedGameId}
            onSelect={setDetailsGameId}
            pinnedIds={vaultState.pinnedIds}
            onTogglePin={(id) => void togglePin(id)}
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
        </section>
      </div>

      <p className="visually-hidden" aria-live="polite">{drawMessage}</p>

      {currentPick ? (
        <section ref={resultRef} className={`${styles.resultCard} ${drawState === "revealed" ? styles.resultRevealed : ""}`} data-visible={drawState === "revealed"}>
          <div className={styles.resultArtwork}>
            <Artwork src={currentPick.bannerUrl} sizes="(max-width: 820px) 100vw, 42vw" priority />
            <span className={styles.currentPickBadge}><VaultIcon name="pin" size={16} />Current pick</span>
          </div>
          <div className={styles.resultBody}>
            <h2 className={styles.resultTitle}>{currentPick.title}</h2>
            <p className={styles.resultCopy}>{currentPick.description}</p>
            <div className={styles.resultSummary}>
              <ResultSummary icon="clock" label="Session" value={vaultSessionOptions.find((option) => option.id === session)?.label ?? "Not selected"} />
              <ResultSummary icon="mood" label="Mood" value={vaultMoodOptions.find((option) => option.id === mood)?.label ?? "Not selected"} />
              <ResultSummary icon="goal" label="Goal" value={vaultGoalOptions.find((option) => option.id === goal)?.label ?? "Not selected"} />
              <ResultSummary icon="genre" label="Genre / context" value={selectedGenres.length ? selectedGenres.join(" · ") : selectedCollection?.name ?? "All games"} />
            </div>
            <div className={styles.resultReasonRow}>
              {(pool.find((entry) => entry.game.id === currentPick.id)?.reasons ?? []).map((reason) => <FilterPill key={reason} label={reason} />)}
            </div>
            <p className={styles.actionsLabel}>Vault actions</p>
            <div className={styles.resultActions}>
              <a href={steamStoreUrl(currentPick.steamAppId)} className={`${styles.resultAction} ${styles.resultActionPrimary}`} target="_blank" rel="noreferrer">
                <VaultIcon name="open-steam" size={26} /><strong>Open on Steam</strong><span>Launch the game</span>
              </a>
              <button type="button" className={styles.resultAction} onClick={() => void togglePin(currentPick.id)}>
                <VaultIcon name="pin" size={26} /><strong>{vaultState.pinnedIds.includes(currentPick.id) ? "Pinned" : "Pin This Pick"}</strong><span>Save for later</span>
              </button>
              <button type="button" className={styles.resultAction} onClick={() => void handleOpenVault()}>
                <VaultIcon name="draw-again" size={26} /><strong>Draw Again</strong><span>Find something else</span>
              </button>
              <button type="button" className={styles.resultAction} onClick={() => void snoozeCurrentPick()}>
                <VaultIcon name="snooze" size={26} /><strong>Not Now</strong><span>Snooze this pick</span>
              </button>
              <button type="button" className={styles.resultAction} onClick={() => setDetailsGameId(currentPick.id)}>
                <VaultIcon name="details" size={26} /><strong>View Details</strong><span>More info</span>
              </button>
            </div>
          </div>
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
      />
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
