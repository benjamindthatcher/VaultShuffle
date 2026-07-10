"use client";

import { useEffect, useMemo, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { LibraryDetailsDrawer } from "@/components/library/LibraryDetailsDrawer";
import { FilterPill } from "@/components/shared/FilterPill";
import { Artwork } from "@/components/shared/Artwork";
import { VaultCollectionCard } from "@/components/vault/VaultCollectionCard";
import { VaultGenreDrawer } from "@/components/vault/VaultGenreDrawer";
import { VaultOptionGroup } from "@/components/vault/VaultOptionGroup";
import { VaultPoolPreview } from "@/components/vault/VaultPoolPreview";
import { type VaultGoalId, type VaultMoodId, type VaultSessionId } from "@/lib/demo-data";
import {
  availableVaultGenres,
  buildVaultPool,
  drawVaultGame,
  vaultGoalOptions,
  vaultMoodOptions,
  vaultSessionOptions
} from "@/lib/vault";
import { steamStoreUrl } from "@/lib/steam-images";
import styles from "./vault.module.css";

export default function VaultPage() {
  const { games, collections, vaultState, recordVaultAction, updateGame, setGameCollection } = useAppData();
  const [session, setSession] = useState<VaultSessionId>("evening");
  const [mood, setMood] = useState<VaultMoodId>("story");
  const [goal, setGoal] = useState<VaultGoalId>("new");
  const [selectedCollectionId, setSelectedCollectionId] = useState("cosmic-odyssey");
  const [selectedGenres, setSelectedGenres] = useState<string[]>(["Sci-Fi", "Adventure"]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [highlightedGameId, setHighlightedGameId] = useState<string | null>(null);
  const [detailsGameId, setDetailsGameId] = useState<string | null>(null);
  const [savingGameId, setSavingGameId] = useState<string | null>(null);

  const ownedGames = useMemo(() => games.filter((game) => game.ownership === "Owned"), [games]);
  const snoozedIds = useMemo(() => new Set(vaultState.snoozedIds), [vaultState.snoozedIds]);
  const genreOptions = useMemo(() => availableVaultGenres(ownedGames), [ownedGames]);
  const selectedCollection = collections.find((collection) => collection.id === selectedCollectionId) ?? collections[0];

  useEffect(() => {
    if (!collections.length) return;
    const exists = collections.some((collection) => collection.id === selectedCollectionId);
    if (!exists) {
      const preferred = collections.find((collection) => collection.kind !== "system") ?? collections[0];
      setSelectedCollectionId(preferred.id);
    }
  }, [collections, selectedCollectionId]);

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
    const nextPick = drawVaultGame(pool);
    if (!nextPick) return;
    await recordVaultAction("drawn", nextPick.id, {
      session,
      mood,
      goal,
      collection_id: selectedCollectionId,
      genres: selectedGenres
    });
    setHighlightedGameId(nextPick.id);
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
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>Vault</p>
          <h1 className={styles.title}>What should we unlock tonight?</h1>
          <p className={styles.description}>
            Set your preferences and let the vault find the perfect game for you.
          </p>
        </div>
      </div>

      <div className={styles.optionStack}>
        <VaultOptionGroup title="1. Session" options={vaultSessionOptions} selectedId={session} onSelect={(id) => setSession(id as VaultSessionId)} />
        <VaultOptionGroup title="2. Mood" options={vaultMoodOptions} selectedId={mood} onSelect={(id) => setMood(id as VaultMoodId)} />
        <VaultOptionGroup title="3. Goal" options={vaultGoalOptions} selectedId={goal} onSelect={(id) => setGoal(id as VaultGoalId)} />
      </div>

      <VaultCollectionCard
        selectedCollection={selectedCollection}
        collections={collections}
        onSelect={(id) => setSelectedCollectionId(id)}
      />

      <section className={styles.filterRail}>
        <div>
          <p className={styles.filterLabel}>Genre filters</p>
          <p className={styles.filterHint}>Optional. Refine your pool.</p>
        </div>
        <button type="button" className={styles.filterButton} onClick={() => setDrawerOpen(true)}>
          {selectedGenres.length ? `${selectedGenres.length} selected` : "Select genres"}
        </button>
      </section>

      <section className={styles.poolSection} id="vault-pool">
        <div className={styles.poolHeader}>
          <div>
            <p className={styles.poolLabel}>Your Pool (Filters)</p>
            <h2 className={styles.poolTitle}>{pool.length} matches ready</h2>
          </div>
          <span className={styles.matchBadge}>{pool.length} Matches</span>
        </div>

        <div className={styles.pillRow}>
          <FilterPill label={selectedCollection.name} />
          <FilterPill label={vaultSessionOptions.find((option) => option.id === session)?.label ?? "Session"} />
          <FilterPill label={vaultMoodOptions.find((option) => option.id === mood)?.label ?? "Mood"} />
          <FilterPill label={vaultGoalOptions.find((option) => option.id === goal)?.label ?? "Goal"} />
          {selectedGenres.map((genre) => (
            <FilterPill key={genre} label={genre} removable onRemove={() => toggleGenre(genre)} />
          ))}
        </div>

        {pool.length ? (
          <VaultPoolPreview
            games={pool.map((entry) => entry.game)}
            highlightedId={highlightedGameId}
            onSelect={setDetailsGameId}
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

      <button type="button" className={styles.ctaButton} onClick={() => void handleOpenVault()} disabled={!pool.length}>
        Open the Vault
      </button>

      {currentPick ? (
        <section className={styles.resultCard}>
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

      <VaultGenreDrawer
        open={drawerOpen}
        genres={genreOptions}
        selectedGenres={selectedGenres}
        onToggleGenre={toggleGenre}
        onClose={() => setDrawerOpen(false)}
        onClear={clearGenres}
      />

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
