"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { Artwork } from "@/components/shared/Artwork";
import { StatCard } from "@/components/shared/StatCard";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { BrandedIcon } from "@/components/shared/BrandedIcon";
import { ManagePinsDialog } from "@/components/shared/ManagePinsDialog";
import { ScrollControls } from "@/components/shared/ScrollControls";
import { WishlistRow } from "@/components/wishlist/WishlistRow";
import { formatGameDuration } from "@/lib/game-duration";
import styles from "./wishlist.module.css";
import type { SteamSearchResult } from "@/lib/types";

export default function WishlistPage() {
  const { games, vaultState, isLive, searchSteam, addWishlistGame, removeGame, refreshSteamMetadata, recordVaultAction } = useAppData();
  const [query, setQuery] = useState("");
  const pinnedGridRef = useRef<HTMLDivElement>(null);
  const [sort, setSort] = useState("added");
  const [filter, setFilter] = useState("all");
  const [composerOpen, setComposerOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [searchResults, setSearchResults] = useState<SteamSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [refreshingPrices, setRefreshingPrices] = useState(false);
  const [priceMessage, setPriceMessage] = useState("");
  const [managePinsOpen, setManagePinsOpen] = useState(false);
  const [pinCandidate, setPinCandidate] = useState<(typeof games)[number] | null>(null);
  const refreshStarted = useRef(false);
  const wishlistGames = useMemo(() => games.filter((game) => game.ownership === "Wishlist"), [games]);
  const ownedSteamAppIds = useMemo(
    () => new Set(games.filter((game) => game.ownership !== "Wishlist").map((game) => game.steamAppId)),
    [games]
  );

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

        const matchesFilter = filter === "all" || (filter === "sale" && Boolean(game.saleDiscount));

        return matchesQuery && matchesFilter;
      })
      .sort((left, right) => {
        if (sort === "price") return Number.parseFloat(left.salePrice?.replace(/[^\d.]/g, "") || "999") - Number.parseFloat(right.salePrice?.replace(/[^\d.]/g, "") || "999");
        if (sort === "discount") return Number.parseInt(right.saleDiscount || "0", 10) - Number.parseInt(left.saleDiscount || "0", 10);
        if (sort === "title") return left.title.localeCompare(right.title);
        return sortableAddedDate(right) - sortableAddedDate(left) || left.title.localeCompare(right.title);
      });
  }, [filter, query, sort, wishlistGames]);

  const onSaleGames = useMemo(() => wishlistGames.filter((game) => Boolean(game.saleDiscount)), [wishlistGames]);

  const stats = useMemo(
    () => ({
      total: wishlistGames.length,
      onSale: onSaleGames.length,
      inLibrary: wishlistGames.filter((game) => ownedSteamAppIds.has(game.steamAppId)).length,
      pinned: vaultState.wishlistPinnedIds.filter((id) => wishlistGames.some((game) => game.id === id)).length
    }),
    [onSaleGames.length, ownedSteamAppIds, vaultState.wishlistPinnedIds, wishlistGames]
  );

  const pinnedGames = vaultState.wishlistPinnedIds
    .map((id) => wishlistGames.find((game) => game.id === id))
    .filter((game): game is (typeof wishlistGames)[number] => Boolean(game));
  const ordinaryWishlist = filteredWishlist.filter((game) => !vaultState.wishlistPinnedIds.includes(game.id));

  async function togglePin(game: (typeof wishlistGames)[number]) {
    if (vaultState.wishlistPinnedIds.includes(game.id)) {
      await recordVaultAction("unpinned", game.id, { pin_scope: "wishlist" });
    } else if (vaultState.wishlistPinnedIds.length < 3) {
      await recordVaultAction("pinned", game.id, { pin_scope: "wishlist" });
    } else {
      setPinCandidate(game);
      setManagePinsOpen(true);
    }
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

  async function refreshPrices() {
    setRefreshingPrices(true);
    setPriceMessage("");
    try {
      const updated = await refreshSteamMetadata(true);
      setPriceMessage(updated ? `${updated} Steam listing${updated === 1 ? "" : "s"} refreshed.` : "Steam prices are already current.");
    } catch {
      setPriceMessage("Steam pricing could not be refreshed right now.");
    } finally {
      setRefreshingPrices(false);
    }
  }

  return (
    <section className={styles.wishlistPage}>
      <header className={styles.header}>
        <h1 className="visually-hidden">Wishlist</h1>
      </header>

      <div className={styles.statsGrid}>
        <StatCard icon="wishlist" label="Wishlist" value={stats.total} note="Everything you are still tracking." />
        <StatCard icon="on-sale" label="On Sale" value={stats.onSale} note="Wishlist games with visible discounts." />
        <StatCard icon="in-library" label="In Library" value={stats.inLibrary} note="Already owned or covered elsewhere." />
        <StatCard actionIcon="pin" label="Pinned" value={stats.pinned} note="Up to three games kept at the front." />
      </div>

      <section className={`${styles.sectionCard} ${styles.pinnedShelf}`}>
        <div className={styles.pinnedHeader}>
          <h2>Pinned Games <span>{pinnedGames.length}/3</span></h2>
          <div className={styles.slotDots} aria-label={`${pinnedGames.length} of 3 wishlist pins used`}>{[0, 1, 2].map((slot) => <span key={slot} data-filled={slot < pinnedGames.length} />)}</div>
          <ScrollControls targetRef={pinnedGridRef} axis="horizontal" label="Browse pinned wishlist games" />
          <button type="button" onClick={() => { setPinCandidate(null); setManagePinsOpen(true); }}>Manage Pins</button>
        </div>
        <div ref={pinnedGridRef} className={styles.pinnedGrid}>
          {pinnedGames.map((game, index) => (
            <article key={game.id} className={styles.pinnedCard}>
              <span className={styles.pinnedArtwork}><Artwork src={game.bannerUrl} sizes="(max-width: 720px) 78vw, 360px" /></span>
              <div className={styles.pinnedBody}><strong>{game.title}</strong><span>{game.salePrice ?? game.addedLabel}</span></div>
              <span className={styles.pinBadge}>⌖ {index + 1}</span>
            </article>
          ))}
          {Array.from({ length: Math.max(0, 3 - pinnedGames.length) }, (_, index) => <div key={`empty-${index}`} className={styles.emptyPin}>Empty slot</div>)}
        </div>
      </section>

      <section className={styles.composerCard}>
        <div className={styles.composerHeader}>
          <div>
            <p className={styles.sectionEyebrow}>Add to wishlist</p>
            <h2 className={styles.composerTitle}>Find a new game</h2>
          </div>
          <button
            type="button"
            className={styles.primaryAction}
            aria-expanded={composerOpen}
            onClick={() => setComposerOpen((current) => !current)}
          >
            <BrandedIcon group="actions" name="add-game" size={25} />
            {composerOpen ? "Close" : "Add Game"}
          </button>
        </div>

        {composerOpen ? (
          <div className={styles.composerBody}>
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
          </div>
        ) : null}
      </section>

      <section className={styles.toolbar}>
        <label className={styles.searchField}>
          <VaultIcon name="search" size={20} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your wishlist..." />
        </label>
        <div className={styles.toolbarControls}>
          <label className={styles.selectField}>
            <span className={styles.controlLabel}><VaultIcon name="sort" size={18} />Sort</span>
            <select value={sort} onChange={(event) => setSort(event.target.value)}>
              <option value="added">Date added</option>
              <option value="title">Title A-Z</option>
              <option value="price">Lowest visible price</option>
              <option value="discount">Biggest discount</option>
            </select>
          </label>
          <label className={styles.selectField}>
            <span className={styles.controlLabel}><VaultIcon name="filter" size={18} />Filter</span>
            <select value={filter} onChange={(event) => setFilter(event.target.value)}>
              <option value="all">All tags</option>
              <option value="sale">On sale</option>
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
          {ordinaryWishlist.map((game) => (
            <WishlistRow
              key={game.id}
              game={game}
              pinned={vaultState.wishlistPinnedIds.includes(game.id)}
              onTogglePin={() => void togglePin(game)}
              removing={removingId === game.id}
              onRemove={async () => {
                setRemovingId(game.id);
                try {
                  if (vaultState.wishlistPinnedIds.includes(game.id)) await recordVaultAction("unpinned", game.id, { pin_scope: "wishlist" });
                  await removeGame(game.id);
                } finally {
                  setRemovingId(null);
                }
              }}
            />
          ))}
          {!ordinaryWishlist.length ? (
            <div className={styles.emptyResults}>No wishlist games match the current search and filter.</div>
          ) : null}
        </div>
      </section>

      <section className={styles.sectionCard}>
        <div className={styles.sectionHeader}>
          <div>
            <p className={styles.sectionEyebrow}>On Sale</p>
            <h2 className={styles.sectionTitle}>{onSaleGames.length} discounted picks</h2>
            <p className={styles.saleIntro}>Current Steam pricing for games you already want.</p>
          </div>
          <div className={styles.priceTools}>
            {priceMessage ? <span role="status">{priceMessage}</span> : null}
            <button type="button" className={styles.secondaryAction} disabled={!isLive || refreshingPrices} onClick={() => void refreshPrices()}>
              <BrandedIcon group="actions" name="refresh-prices" size={22} />
              {refreshingPrices ? "Refreshing…" : "Refresh Steam prices"}
            </button>
          </div>
        </div>
        <div className={styles.saleGrid}>
          {onSaleGames.map((game) => (
            <article key={game.id} className={styles.saleCardWrap}>
              <div className={styles.saleArtwork}><Artwork src={game.bannerUrl} sizes="(max-width: 720px) 100vw, 360px" /></div>
              <div className={styles.saleBody}>
                <span className={styles.discountBadge}>{game.saleDiscount}</span>
                <h3>{game.title}</h3>
                {formatGameDuration(game.duration) ? <p>{formatGameDuration(game.duration)}</p> : null}
                <div className={styles.saleMeta}>
                  <span>{game.saleOriginalPrice ? <s>{game.saleOriginalPrice}</s> : "Steam sale"}</span>
                  <strong>{game.salePrice}</strong>
                </div>
                <a href={`https://store.steampowered.com/app/${game.steamAppId}`} target="_blank" rel="noreferrer">View on Steam <span aria-hidden="true">↗</span></a>
              </div>
            </article>
          ))}
          {!onSaleGames.length ? <div className={styles.saleEmpty}>No tracked games are discounted right now. Refresh prices later and we’ll keep this area current.</div> : null}
        </div>
      </section>
      {managePinsOpen ? <ManagePinsDialog
        pinnedGames={pinnedGames}
        candidate={pinCandidate && !vaultState.wishlistPinnedIds.includes(pinCandidate.id) ? pinCandidate : null}
        shelfName="Wishlist"
        shelfDescription="Pinned games stay at the front of your Wishlist without affecting Library pins."
        onRemove={async (id) => { await recordVaultAction("unpinned", id, { pin_scope: "wishlist" }); }}
        onReplace={async (replaceId) => { if (pinCandidate) await recordVaultAction("pinned", pinCandidate.id, { pin_scope: "wishlist", replace_game_id: replaceId }); }}
        onClose={() => { setManagePinsOpen(false); setPinCandidate(null); }}
      /> : null}
    </section>
  );
}

function sortableAddedDate(game: { dateAdded?: string | null; addedLabel: string }) {
  const timestamp = Date.parse(game.dateAdded || game.addedLabel.replace(/^Added\s+/i, ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}
