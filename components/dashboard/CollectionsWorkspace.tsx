"use client";

import type { Collection, CollectionGame, Game } from "@/lib/types";
import { displayStatus, lengthBucket } from "@/lib/game-classification";
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
  const selectedCollection = collections.find((collection) => collection.id === selectedCollectionId) ?? null;
  const selectedGameIds = new Set(collectionItems.map((item) => item.game_id));
  const availableGames = games.filter((game) => !selectedGameIds.has(game.id));

  if (!isLoggedIn) {
    return (
      <section className="workspace-panel collections-workspace">
        <div className="workspace-empty">
          <h1>Collections</h1>
          <p>Sign in with Steam to create collections that sync between visits.</p>
          <a className="shuffle-button link-button" href="/login">Sign in with Steam</a>
        </div>
      </section>
    );
  }

  return (
    <div className="collections-workspace collections-layout">
      <aside className="collection-list-panel">
        <div className="workspace-heading">
          <div>
            <p className="detail-kicker">Collections</p>
            <h2>My Collections</h2>
          </div>
        </div>
        <div className="collection-list">
          {collections.map((collection) => (
            <button
              className={collection.id === selectedCollectionId ? "active" : ""}
              key={collection.id}
              onClick={() => onSelectCollection(collection)}
              type="button"
            >
              <span>{collection.name}</span>
              <strong>{collection.game_count ?? 0}</strong>
            </button>
          ))}
        </div>
        <form className="create-collection-form" onSubmit={onCreateCollection}>
          <input value={collectionName} onChange={(event) => setCollectionName(event.target.value)} placeholder="Collection name" />
          <textarea value={collectionDescription} onChange={(event) => setCollectionDescription(event.target.value)} placeholder="Description" />
          <button className="shuffle-button" type="submit">Create Collection</button>
        </form>
      </aside>

      <section className="workspace-panel collection-detail-panel">
        {selectedCollection ? (
          <>
            <div className="workspace-heading">
              <div>
                <h1>{selectedCollection.name}</h1>
                <p>{selectedCollection.description || "Group games by mood, genre, device, or whatever fits your style."}</p>
              </div>
              <div className="collection-stats">
                <strong>{collectionItems.length}</strong>
                <span>games</span>
              </div>
            </div>
            <div className="collection-add-row">
              <select value={collectionGameId} onChange={(event) => setCollectionGameId(event.target.value)}>
                <option value="">Add an existing game...</option>
                {availableGames.map((game) => <option value={game.id} key={game.id}>{game.title}</option>)}
              </select>
              <button className="ghost" onClick={onAddGame} type="button">Add Game</button>
            </div>
            <div className="collection-game-table">
              <div className="collection-game-head">
                <span>Game</span>
                <span>Genre</span>
                <span>Length</span>
                <span>Status</span>
                <span />
              </div>
              {collectionItems.length ? collectionItems.map((item) => item.game ? (
                <div className="collection-game-row" key={item.game_id}>
                  <span className="game-cell"><Cover game={item.game} /><strong>{item.game.title}</strong></span>
                  <span>{displayGenres(item.game)}</span>
                  <span>{lengthBucket(item.game)}</span>
                  <span>{displayStatus(item.game)}</span>
                  <button className="ghost" onClick={() => onRemoveGame(item.game_id)} type="button">Remove</button>
                </div>
              ) : null) : <div className="workspace-empty">Add games to start this collection.</div>}
            </div>
          </>
        ) : (
          <div className="workspace-empty">Create or select a collection to get started.</div>
        )}
      </section>
    </div>
  );
}
