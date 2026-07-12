"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { GameCard } from "@/components/shared/GameCard";
import { Artwork } from "@/components/shared/Artwork";
import { StatCard } from "@/components/shared/StatCard";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { WishlistRow } from "@/components/wishlist/WishlistRow";
import styles from "./wishlist.module.css";
import type { SteamSearchResult } from "@/lib/types";

export default function WishlistPage() {
  const { games, isLive, searchSteam, addWishlistGame, updateGame, removeGame, refreshSteamMetadata } = useAppData();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("added");
  const [filter, setFilter] = useState("all");
  const [composerOpen, setComposerOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [searchResults, setSearchResults] = useState<SteamSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const refreshStarted = useRef(false);
  const wishlistGames = useMemo(() => games.filter((game) => game.ownership === "Wishlist"), [games]);

  useEffect(() => {
    if (!isLive || refreshStarted.current) return;
    refreshStarted.current = true;
    void refreshSteamMetadata();
  }, [isLive, refreshSteamMetadata]);

  const filteredWishlist = useMemo(() => {
    const queryText = query.trim().toLowerCase();

    return [...wishlistGames]
      .filter((game) => {
        const matchesQuery =
          !queryText ||
          game.title.toLowerCase().includes(queryText) ||
          game.genres.join(" ").toLowerCase().includes(queryText);

        const matchesFilter =
          filter === "all" ||
          (filter === "sale" && Boolean(game.saleDiscount)) ||
          (filter === "priority" && game.priority === "Must Play");

        return matchesQuery && matchesFilter;
      })
      .sort((left, right) => {
        if (sort === "price") return Number.parseFloat(left.salePrice?.replace(/[^\d.]/g, "") || "999") - Number.parseFloat(right.salePrice?.replace(/[^\d.]/g, "") || "999");
        if (sort === "title") return left.title.localeCompare(right.title);
        return right.priority.localeCompare(left.priority);
      });
  }, [filter, query, sort, wishlistGames]);

  const onSaleGames = useMemo(() => wishlistGames.filter((game) => Boolean(game.saleDiscount)), [wishlistGames]);

  const stats = useMemo(
    () => ({
      total: wishlistGames.length,
      onSale: onSaleGames.length,
      inLibrary: 0,
      following: wishlistGames.filter((game) => game.priority === "Must Play").length
    }),
    [onSaleGames.length, wishlistGames]
  );

  async function toggleLike(id: string) {
    const game = wishlistGames.find((item) => item.id === id);
    if (!game) return;
    await updateGame(id, { priority: game.priority === "Must Play" ? "High" : "Must Play" });
  }

  async function handleSteamSearch() {
    if (!nameDraft.trim()) return;
    setSearching(true);
    try {
      setSearchResults(await searchSteam(nameDraft));
    } finally {
      setSearching(false);
    }
  }

  async function handleAddWishlistGame(result: SteamSearchResult) {
    await addWishlistGame({
      title: result.name,
      genre: result.genre || "Unknown",
      steamAppId: result.appid,
      image: result.image
    });
    setComposerOpen(false);
    setNameDraft("");
    setSearchResults([]);
  }

  return (
    <section className={styles.wishlistPage}>
      <header className={styles.header}>
        <h1 className="visually-hidden">Wishlist</h1>
        <button type="button" className={styles.primaryAction} onClick={() => setComposerOpen((current) => !current)}>
          <VaultIcon name="new" /> Add Game
        </button>
      </header>

      {composerOpen ? (
        <section className={styles.composerCard}>
          <div className={styles.composerGrid}>
            <label className={styles.field}>
              <span>Search Steam</span>
              <input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void handleSteamSearch(); } }} placeholder="Search by game name" />
            </label>
          </div>
          {searchResults.length ? (
            <div className={styles.searchResults}>
              {searchResults.map((result) => (
                <button key={result.appid} type="button" className={styles.searchResult} onClick={() => void handleAddWishlistGame(result)}>
                  <span className={styles.searchArtwork}><Artwork src={result.image} sizes="92px" /></span>
                  <span><strong>{result.name}</strong><small>{result.genre || "Steam game"}</small></span>
                  <span>Add</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className={styles.composerActions}>
            <button type="button" className={styles.secondaryAction} onClick={() => setComposerOpen(false)}>
              Cancel
            </button>
            <button type="button" className={styles.primaryAction} disabled={searching} onClick={() => void handleSteamSearch()}>
              {searching ? "Searching…" : "Search Steam"}
            </button>
          </div>
        </section>
      ) : null}

      <div className={styles.statsGrid}>
        <StatCard label="Wishlist" value={stats.total} note="Everything you are still tracking." />
        <StatCard label="On Sale" value={stats.onSale} note="Wishlist games with visible discounts." />
        <StatCard label="In Library" value={stats.inLibrary} note="Already owned or covered elsewhere." />
        <StatCard label="Following" value={stats.following} note="Saved or high-priority targets." />
      </div>

      <section className={styles.toolbar}>
        <label className={styles.searchField}>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your wishlist..." />
        </label>
        <div className={styles.toolbarControls}>
          <label className={styles.selectField}>
            <span className={styles.controlLabel}><VaultIcon name="sort" size={18} />Sort</span>
            <select value={sort} onChange={(event) => setSort(event.target.value)}>
              <option value="added">Priority</option>
              <option value="title">Title A-Z</option>
              <option value="price">Lowest visible price</option>
            </select>
          </label>
          <label className={styles.selectField}>
            <span className={styles.controlLabel}><VaultIcon name="filter" size={18} />Filter</span>
            <select value={filter} onChange={(event) => setFilter(event.target.value)}>
              <option value="all">All tags</option>
              <option value="sale">On sale</option>
              <option value="priority">Must play</option>
            </select>
          </label>
        </div>
      </section>

      <section className={styles.sectionCard}>
        <div className={styles.sectionHeader}>
          <div>
            <h2 className={styles.sectionTitle}>Top of Wishlist</h2>
          </div>
        </div>
        <div className={styles.rowList}>
          {filteredWishlist.map((game) => (
            <WishlistRow
              key={game.id}
              game={game}
              liked={game.priority === "Must Play"}
              onToggleLike={() => void toggleLike(game.id)}
              removing={removingId === game.id}
              onRemove={async () => {
                setRemovingId(game.id);
                try {
                  await removeGame(game.id);
                } finally {
                  setRemovingId(null);
                }
              }}
            />
          ))}
        </div>
      </section>

      <section className={styles.sectionCard}>
        <div className={styles.sectionHeader}>
          <div>
            <p className={styles.sectionEyebrow}>On Sale</p>
            <h2 className={styles.sectionTitle}>{onSaleGames.length} discounted picks</h2>
          </div>
        </div>
        <div className={styles.saleGrid}>
          {onSaleGames.map((game) => (
            <div key={game.id} className={styles.saleCardWrap}>
              <GameCard game={game} />
              <div className={styles.saleMeta}>
                <span>{game.saleDiscount}</span>
                <strong>{game.salePrice}</strong>
              </div>
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}
