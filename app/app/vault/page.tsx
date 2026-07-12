"use client";

import { useMemo, useRef, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { LibraryDetailsDrawer } from "@/components/library/LibraryDetailsDrawer";
import { FilterPill } from "@/components/shared/FilterPill";
import { Artwork } from "@/components/shared/Artwork";
import { VaultCollectionCard } from "@/components/vault/VaultCollectionCard";
import { VaultGenrePanel } from "@/components/vault/VaultGenrePanel";
import { VaultOptionGroup } from "@/components/vault/VaultOptionGroup";
import { VaultPoolPreview } from "@/components/vault/VaultPoolPreview";
import { type VaultGoalId, type VaultMoodId, type VaultSessionId } from "@/lib/demo-data";
import {
  availableVaultGenres,
  buildVaultAnimationSequence,
  buildVaultPool,
  drawVaultGame,
  type VaultPoolEntry,
  vaultGoalOptions,
  vaultMoodOptions,
  vaultSessionOptions
} from "@/lib/vault";
import { steamStoreUrl } from "@/lib/steam-images";
import styles from "./vault.module.css";

type VaultDrawState = "idle" | "preparing" | "shuffling" | "settling" | "revealing" | "revealed" | "error";

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
  const [animationEntries, setAnimationEntries] = useState<VaultPoolEntry[]>([]);
  const [drawMessage, setDrawMessage] = useState("");
  const drawingRef = useRef(false);

  const ownedGames = useMemo(() => games.filter((game) => game.ownership === "Owned"), [games]);
  const snoozedIds = useMemo(() => new Set(vaultState.snoozedIds), [vaultState.snoozedIds]);
  const genreOptions = useMemo(() => availableVaultGenres(ownedGames), [ownedGames]);
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

  async function handleOpenVault() {
    if (drawingRef.current || !pool.length) return;
    const nextPick = drawVaultGame(pool, currentPick?.id);
    if (!nextPick) return;

    drawingRef.current = true;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setDrawWinnerId(nextPick.id);
    setAnimationEntries(buildVaultAnimationSequence(pool, nextPick.id));
    setHighlightedGameId(null);
    setDrawMessage("Opening the Vault.");
    setDrawState("preparing");

    try {
      if (reducedMotion || pool.length === 1) {
        await wait(180);
        setDrawState("revealing");
      } else {
        await wait(120);
        setDrawState("shuffling");
        setDrawMessage("Narrowing down your choices.");
        await wait(580);
        setDrawState("settling");
        await wait(400);
        setDrawState("revealing");
        await wait(250);
      }

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
    } catch (error) {
      console.error("Vault draw failed", error);
      setDrawState("error");
      setDrawMessage("The Vault could not complete the draw. Please try again.");
    } finally {
      drawingRef.current = false;
    }
  }

  function toggleGenre(genre: string) {
    setSelectedGenres((current) =>
      current.includes(genre) ? current.filter((item) => item !== genre) : [...current, genre]
    );
  }

  function clearGenres() {
    setSelectedGenres([]);
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
            genres={genreOptions}
            selectedGenres={selectedGenres}
            onToggleGenre={toggleGenre}
            onClear={clearGenres}
          />
          <button type="button" className={styles.ctaButton} onClick={() => void handleOpenVault()} disabled={!pool.length || drawingRef.current} aria-busy={drawingRef.current}>
            {drawState === "preparing" || drawState === "shuffling" || drawState === "settling" || drawState === "revealing" ? "Opening the Vault…" : "Open the Vault"}
          </button>
        </div>

        <section className={styles.poolSection} id="vault-pool">
        <div className={styles.poolHeader}>
          <div>
            <p className={styles.poolLabel}>Your Pool (Filters)</p>
          </div>
          <span className={styles.matchBadge}>{pool.length} Matches</span>
        </div>

        <div className={styles.pillRow}>
          {selectedCollection ? <FilterPill label={selectedCollection.name} /> : null}
          {session ? <FilterPill label={vaultSessionOptions.find((option) => option.id === session)?.label ?? "Session"} /> : null}
          {mood ? <FilterPill label={vaultMoodOptions.find((option) => option.id === mood)?.label ?? "Mood"} /> : null}
          {goal ? <FilterPill label={vaultGoalOptions.find((option) => option.id === goal)?.label ?? "Goal"} /> : null}
          {selectedGenres.map((genre) => (
            <FilterPill key={genre} label={genre} removable onRemove={() => toggleGenre(genre)} />
          ))}
        </div>

        {pool.length ? (
          <VaultPoolPreview
            entries={drawState === "preparing" || drawState === "shuffling" || drawState === "settling" || drawState === "revealing" ? animationEntries : pool}
            drawState={drawState}
            winnerId={drawWinnerId}
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
        <section className={`${styles.resultCard} ${drawState === "revealed" ? styles.resultRevealed : ""}`}>
          <div className={styles.resultArtwork}>
            <Artwork src={currentPick.bannerUrl} sizes="(max-width: 820px) 100vw, 42vw" priority />
          </div>
          <div className={styles.resultBody}>
            <p className={styles.resultEyebrow}>Vault draw</p>
            <h2 className={styles.resultTitle}>{currentPick.title}</h2>
            <p className={styles.resultCopy}>{currentPick.description}</p>
            <div className={styles.resultReasonRow}>
              {(pool.find((entry) => entry.game.id === currentPick.id)?.reasons ?? []).map((reason) => (
                <FilterPill key={reason} label={reason} />
              ))}
            </div>
            <div className={styles.resultActions}>
              <a href={steamStoreUrl(currentPick.steamAppId)} className={styles.primaryAction} target="_blank" rel="noreferrer">
                Open on Steam
              </a>
              <button type="button" className={styles.secondaryAction} onClick={() => void togglePin(currentPick.id)}>
                {vaultState.pinnedIds.includes(currentPick.id) ? "Pinned" : "Pin This Pick"}
              </button>
              <button type="button" className={styles.secondaryAction} onClick={() => void handleOpenVault()}>
                Draw Again
              </button>
              <button type="button" className={styles.secondaryAction} onClick={() => void snoozeCurrentPick()}>
                Not Now
              </button>
              <button type="button" className={styles.secondaryAction} onClick={() => setDetailsGameId(currentPick.id)}>
                View Details
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
