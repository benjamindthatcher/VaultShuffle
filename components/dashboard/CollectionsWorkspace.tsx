"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Collection, CollectionGame, Game } from "@/lib/types";
import { displayGenres } from "@/lib/game-display";
import { CollectionPreviewArtwork, Cover } from "@/components/dashboard/GameArtwork";

export function CollectionsWorkspace({
  collectionGameId,
  collectionItems,
  collectionPreviewGames,
  collections,
  collectionsLoaded,
  games,
  isLoggedIn,
  onAddGame,
  onDeleteCollection,
  onRemoveGame,
  onSelectCollection,
  selectedCollectionId,
  setCollectionGameId
}: {
  collectionDescription: string;
  collectionGameId: string;
  collectionItems: CollectionGame[];
  collectionName: string;
  collectionPreviewGames: Record<string, Game[]>;
  collections: Collection[];
  collectionsLoaded: boolean;
  games: Game[];
  isLoggedIn: boolean;
  onAddGame: () => void;
  onCreateCollection: (event: React.FormEvent<HTMLFormElement>) => void;
  onDeleteCollection: (collection: Collection) => void;
  onRemoveGame: (gameId: string) => void;
  onSelectCollection: (collection: Collection) => void;
  selectedCollectionId: string | null;
  setCollectionDescription: (value: string) => void;
  setCollectionGameId: (value: string) => void;
  setCollectionName: (value: string) => void;
}) {
  const selectedCollection = collections.find((collection) => collection.id === selectedCollectionId) ?? collections[0] ?? null;
  const selectedGameIds = new Set(collectionItems.map((item) => item.game_id));
  const availableGames = games.filter((game) => !selectedGameIds.has(game.id));
  const hasCollections = collections.length > 0;
  const [rowMenuGameId, setRowMenuGameId] = useState<string | null>(null);
  const collectionCarouselRef = useRef<HTMLDivElement | null>(null);
  const [canScrollCollectionsLeft, setCanScrollCollectionsLeft] = useState(false);
  const [canScrollCollectionsRight, setCanScrollCollectionsRight] = useState(false);

  const updateCollectionCarouselButtons = useCallback(() => {
    const carousel = collectionCarouselRef.current;
    if (!carousel) {
      setCanScrollCollectionsLeft(false);
      setCanScrollCollectionsRight(false);
      return;
    }

    const maxScrollLeft = Math.max(0, carousel.scrollWidth - carousel.clientWidth);
    setCanScrollCollectionsLeft(carousel.scrollLeft > 4);
    setCanScrollCollectionsRight(carousel.scrollLeft < maxScrollLeft - 4);
  }, []);

  const scrollCollectionCarousel = useCallback((direction: "left" | "right") => {
    const carousel = collectionCarouselRef.current;
    if (!carousel) return;

    const firstCard = carousel.querySelector<HTMLElement>(".core-collection-card");
    const styles = window.getComputedStyle(carousel);
    const gap = Number.parseFloat(styles.columnGap || styles.gap || "0") || 0;
    const cardWidth = firstCard?.getBoundingClientRect().width || carousel.clientWidth / 3;

    carousel.scrollBy({
      left: direction === "right" ? cardWidth + gap : -(cardWidth + gap),
      behavior: "smooth",
    });
  }, []);

  useEffect(() => {
    updateCollectionCarouselButtons();
    const carousel = collectionCarouselRef.current;
    if (!carousel) return;

    const refresh = () => updateCollectionCarouselButtons();
    const timer = window.setTimeout(refresh, 0);
    carousel.addEventListener("scroll", refresh, { passive: true });
    window.addEventListener("resize", refresh);

    return () => {
      window.clearTimeout(timer);
      carousel.removeEventListener("scroll", refresh);
      window.removeEventListener("resize", refresh);
    };
  }, [collections.length, updateCollectionCarouselButtons]);

  if (!isLoggedIn) {
    return (
      <section className="workspace-panel collections-workspace collections-redesign collections-core-v3">
        <div className="workspace-empty">
          <h1>Collections</h1>
          <p>Sign in with Steam to create collections that sync between visits.</p>
          <a className="shuffle-button link-button" href="/login">Sign in with Steam</a>
        </div>
      </section>
    );
  }

  if (!collectionsLoaded) {
    return (
      <div className="collections-workspace collections-redesign collections-core-v3 collections-loading-core">
        <section className="collections-main-heading">
          <h1>Your Collections</h1>
        </section>

        <section className="collection-detail-showcase collection-detail-empty">
          <aside className="selected-collection-card">
            <h2>Loading collections</h2>
            <p>Your collections are being loaded.</p>
          </aside>

          <div className="selected-collection-games empty-collection-prompt">
            <h2>Loading your vault…</h2>
            <p>This should only take a moment.</p>
          </div>
        </section>
      </div>
    );
  }

  if (!hasCollections) {
    return (
      <div className="collections-workspace collections-redesign collections-core-v3 collections-empty-core">
        <section className="collections-main-heading">
          <h1>Your Collections <span>(0)</span></h1>
        </section>

        <section className="collection-detail-showcase collection-detail-empty">
          <aside className="selected-collection-card">
            <h2>Select a collection</h2>
            <p>Use the + New Collection button on the left to create your first collection.</p>
            <strong>0 games</strong>
          </aside>

          <div className="selected-collection-games empty-collection-prompt">
            <h2>Create a collection from the sidebar</h2>
            <p>Collections you create will appear here, then you can add games to them.</p>
          </div>
        </section>
      </div>
    );
  }

  const selectedGameCount = selectedCollection?.game_count ?? collectionItems.length;

  return (
    <div className="collections-workspace collections-redesign collections-core-v3">
      <section className="collections-main-heading">
        <h1>Your Collections <span>({collections.length})</span></h1>
      </section>

      <section className="collection-carousel-shell" aria-label="Collections">
        <div className="collection-card-strip core-collection-card-strip" ref={collectionCarouselRef}>
          {collections.map((collection) => {
            const isActive = collection.id === selectedCollection?.id;
            const preview = collectionPreviewGames[collection.id] ?? [];

            return (
              <button
                className={`collection-showcase-card core-collection-card ${isActive ? "active" : ""}`}
                key={collection.id}
                onClick={() => {
                  setRowMenuGameId(null);
                  onSelectCollection(collection);
                }}
                type="button"
              >
                <CollectionPreview games={preview} collectionName={collection.name} />

                <span className="collection-card-title-row">
                  <strong>{collection.name}</strong>
                </span>

                {collection.description ? <p>{collection.description}</p> : <p className="collection-card-description-empty" aria-hidden="true" />}
                <em>{collection.game_count ?? 0} games</em>
              </button>
            );
          })}
        </div>

        <button
          type="button"
          className="collection-carousel-arrow collection-carousel-arrow-left"
          onClick={() => scrollCollectionCarousel("left")}
          disabled={!canScrollCollectionsLeft}
          aria-label="Show previous collection"
        >
          ‹
        </button>

        <button
          type="button"
          className="collection-carousel-arrow collection-carousel-arrow-right"
          onClick={() => scrollCollectionCarousel("right")}
          disabled={!canScrollCollectionsRight}
          aria-label="Show next collection"
        >
          ›
        </button>
      </section>

      <section className="collection-detail-showcase core-collection-detail">
        <aside className="selected-collection-card core-selected-collection-card">
          <h2>
            {selectedCollection?.name || "Select a collection"}
          </h2>

          {selectedCollection ? (
            <p className={!selectedCollection.description ? "collection-selected-description-empty" : undefined}>
              {selectedCollection.description || ""}
            </p>
          ) : (
            <p>Pick a collection above to see the games inside it.</p>
          )}
          <strong>{selectedGameCount} games</strong>

          <button className="ghost" type="button">
            Edit Collection
          </button>
          <button
            className="ghost"
            onClick={() => selectedCollection && onDeleteCollection(selectedCollection)}
            type="button"
          >
            Delete Collection
          </button>

          <small>
            <span>Last updated</span>
            <b>{formatUpdatedAt(selectedCollection?.updated_at)}</b>
          </small>
        </aside>

        <div className="selected-collection-games core-selected-collection-games">
          <div className="selected-collection-header">
            <h2>Games in this collection <span>({selectedGameCount})</span></h2>

            <div className="collection-add-row">
              <select value={collectionGameId} onChange={(event) => setCollectionGameId(event.target.value)}>
                <option value="">Add an existing game...</option>
                {availableGames.map((game) => <option value={game.id} key={game.id}>{game.title}</option>)}
              </select>

              <button className="ghost" onClick={onAddGame} type="button">Add Game</button>
            </div>
          </div>

          <div className="collection-game-table">
            <div className="collection-game-head">
              <span>Game</span>
              <span>Playtime</span>
              <span>Genre</span>
              <span />
            </div>

            {collectionItems.length ? collectionItems.map((item) => item.game ? (
              <div className="collection-game-row" key={item.game_id}>
                <span className="game-cell">
                  <Cover game={item.game} />
                  <strong>{item.game.title}</strong>
                </span>
                <span>{Number(item.game.hours_played || 0).toLocaleString()}h</span>
                <span>{displayGenres(item.game)}</span>
                <span className="row-menu-cell collection-row-menu-cell">
                  <button
                    className="row-menu-button"
                    onClick={() => setRowMenuGameId((current) => current === item.game_id ? null : item.game_id)}
                    type="button"
                    aria-label={`Actions for ${item.game.title}`}
                    aria-expanded={rowMenuGameId === item.game_id}
                  >
                    ⋮
                  </button>

                  {rowMenuGameId === item.game_id ? (
                    <span className="row-menu collection-row-menu">
                      <button
                        onClick={() => {
                          setRowMenuGameId(null);
                          onRemoveGame(item.game_id);
                        }}
                        type="button"
                      >
                        Delete
                      </button>
                    </span>
                  ) : null}
                </span>
              </div>
            ) : null) : <div className="workspace-empty">Add games to start this collection.</div>}
          </div>
        </div>
      </section>
    </div>
  );
}

function CollectionPreview({ games, collectionName }: { games: Game[]; collectionName: string }) {
  if (!games.length) {
    return (
      <span className="collection-preview-mosaic collection-preview-empty" aria-hidden="true">
        <span>{initials(collectionName)}</span>
        <span>♚</span>
        <span>VS</span>
      </span>
    );
  }

  return (
    <span className="collection-preview-mosaic" aria-hidden="true">
      {games.slice(0, 3).map((game) => (
        <span className="collection-preview-tile" key={game.id}>
          <CollectionPreviewArtwork game={game} />
        </span>
      ))}
    </span>
  );
}

function formatUpdatedAt(value?: string) {
  if (!value) return "Today";
  const updated = new Date(value);
  if (Number.isNaN(updated.getTime())) return "Today";

  const now = new Date();
  const sameDay = updated.toDateString() === now.toDateString();
  if (sameDay) return "Today";

  return updated.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

function initials(value: string) {
  return (
    value
      .replace(/[^a-zA-Z0-9 ]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0])
      .join("")
      .toUpperCase() || "VS"
  );
}
