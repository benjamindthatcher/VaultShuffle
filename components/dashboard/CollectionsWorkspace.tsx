"use client";

import type { Collection, CollectionGame, Game } from "@/lib/types";
import { displayGenres } from "@/lib/game-display";
import { Cover } from "@/components/dashboard/GameArtwork";

export function CollectionsWorkspace({
  collectionDescription,
  collectionGameId,
  collectionItems,
  collectionName,
  collections,
  games,
  isLoggedIn,
  onAddGame,
  onCreateCollection,
  onRemoveGame,
  onSelectCollection,
  selectedCollectionId,
  setCollectionDescription,
  setCollectionGameId,
  setCollectionName
}: {
  collectionDescription: string;
  collectionGameId: string;
  collectionItems: CollectionGame[];
  collectionName: string;
  collections: Collection[];
  games: Game[];
  isLoggedIn: boolean;
  onAddGame: () => void;
  onCreateCollection: (event: React.FormEvent<HTMLFormElement>) => void;
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

  if (!isLoggedIn) {
    return (
      <section className="workspace-panel collections-workspace collections-redesign">
        <div className="workspace-empty">
          <h1>Collections</h1>
          <p>Sign in with Steam to create collections that sync between visits.</p>
          <a className="shuffle-button link-button" href="/login">Sign in with Steam</a>
        </div>
      </section>
    );
  }

  return (
    <div className="collections-workspace collections-redesign">
      <section className="collections-main-heading">
        <h1>Your Collections <span>({collections.length})</span></h1>
      </section>

      {hasCollections ? (
        <section className="collection-card-strip" aria-label="Collections">
          {collections.slice(0, 4).map((collection, index) => (
            <button
              className={`collection-showcase-card ${collection.id === selectedCollection?.id ? "active" : ""}`}
              key={collection.id}
              onClick={() => onSelectCollection(collection)}
              type="button"
            >
              <span className="collection-cover-stack">
                {previewGames(games, index).map((game) => (
                  <span key={`${collection.id}-${game.id}`}>
                    <Cover game={game} />
                  </span>
                ))}
              </span>

              <strong>
                {collection.name}
                <small>You</small>
              </strong>

              <p>{collection.description || collectionDescriptionFor(collection.name)}</p>
              <em>{collection.game_count ?? 0} games</em>
            </button>
          ))}
        </section>
      ) : (
        <section
          className="collection-card-strip"
          aria-label="Collections"
          style={{
            display: "block",
            minHeight: 0
          }}
        >
          <div
            className="workspace-empty"
            style={{
              maxWidth: "none",
              margin: 0,
              padding: 0,
              textAlign: "left"
            }}
          >
            Create your first collection to get started.
          </div>
        </section>
      )}

      <section className="collection-detail-showcase">
        <aside className="selected-collection-card">
          <div className="selected-collection-icon" aria-hidden="true">♚</div>

          <h2>
            {selectedCollection?.name || "Select a collection"}
            {selectedCollection ? <span>You</span> : null}
          </h2>

          <p>{selectedCollection?.description || "Create or select a collection to see the games inside it."}</p>
          <strong>{collectionItems.length} games</strong>

          {selectedCollection ? (
            <>
              <button className="shuffle-button" type="button">⟲ Play Shuffle</button>
              <button className="ghost" type="button" onClick={() => document.querySelector<HTMLInputElement>(".create-collection-form input")?.focus()}>
                ✎ Edit Collection
              </button>

              <small>Last updated <b>Today</b></small>
            </>
          ) : null}
        </aside>

        <div className="selected-collection-games">
          <div className="selected-collection-header">
            <h2>
              {selectedCollection ? "Games in this collection" : "Create a collection"}{" "}
              <span>{selectedCollection ? `(${collectionItems.length})` : ""}</span>
            </h2>

            {selectedCollection ? (
              <div className="collection-add-row">
                <select value={collectionGameId} onChange={(event) => setCollectionGameId(event.target.value)}>
                  <option value="">Add an existing game...</option>
                  {availableGames.map((game) => <option value={game.id} key={game.id}>{game.title}</option>)}
                </select>

                <button className="ghost" onClick={onAddGame} type="button">Add Game</button>
              </div>
            ) : null}
          </div>

          {!selectedCollection ? (
            <form
              className="create-collection-form collection-create-inline"
              onSubmit={onCreateCollection}
              style={{ marginTop: 0 }}
            >
              <input value={collectionName} onChange={(event) => setCollectionName(event.target.value)} placeholder="New collection name" />
              <input value={collectionDescription} onChange={(event) => setCollectionDescription(event.target.value)} placeholder="Description" />
              <button className="shuffle-button" type="submit">Create Collection</button>
            </form>
          ) : (
            <>
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
                    <button className="row-menu-button" onClick={() => onRemoveGame(item.game_id)} type="button" aria-label={`Remove ${item.game.title}`}>
                      ⋮
                    </button>
                  </div>
                ) : null) : <div className="workspace-empty">Add games to start this collection.</div>}
              </div>

              <form className="create-collection-form collection-create-inline" onSubmit={onCreateCollection}>
                <input value={collectionName} onChange={(event) => setCollectionName(event.target.value)} placeholder="New collection name" />
                <input value={collectionDescription} onChange={(event) => setCollectionDescription(event.target.value)} placeholder="Description" />
                <button className="shuffle-button" type="submit">Create Collection</button>
              </form>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function previewGames(games: Game[], index: number) {
  if (!games.length) return [];
  const start = (index * 2) % games.length;
  const selected = [games[start], games[(start + 1) % games.length], games[(start + 2) % games.length]].filter(Boolean);
  return selected.length ? selected : games.slice(0, 3);
}

function collectionDescriptionFor(name: string) {
  const lower = name.toLowerCase();
  if (lower.includes("co-op") || lower.includes("coop")) return "Perfect picks for friends.";
  if (lower.includes("strategy")) return "Tactical, thoughtful, and deep.";
  if (lower.includes("story")) return "Great narratives, start to finish.";
  if (lower.includes("backlog")) return "Shorter games, big fun.";
  return "A focused set from your vault.";
}
