"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { requestJson } from "@/lib/api-client";
import { decodeCatalogue, type CataloguePayload } from "@/lib/catalogue-wire";
import { WISHLIST_PICK_COUNT, WISHLIST_BUDGET_RESERVE, WISHLIST_BUDGET_SCAN, cheapWishlistBand, recommendWishlist, wishlistOwned, type WishlistGame, type WishlistMode, type WishlistInteractionContext, type WishlistPick } from "@/lib/wishlist";
import { ANALYTICS_EVENTS, trackEvent, trackNavigationEvent } from "@/lib/analytics";
import { isSteamStoreCountry, steamPriceMarket } from "@/lib/steam-store-regions";
import { readWishlistPickHistory, rememberWishlistPicks, wishlistHistoryStorageKey } from "@/lib/wishlist-pick-history";
import { GuestPreviewNotice } from "@/components/guest/GuestPreviewNotice";
import { useWishlistDetails } from "./useWishlistDetails";
import { WishlistDetailsDrawer } from "./WishlistDetailsDrawer";
import { WishlistCard } from "./WishlistCard";
import { WishlistRegionMenu } from "./WishlistRegionMenu";
import { useWishlist } from "./useWishlist";
import styles from "./Wishlist.module.css";

const EMPTY_LIBRARY: ReturnType<typeof useAppData>["allGames"] = [];
const STORE_REGION_KEY = "vault-wishlist-store-region-v1";

export function WishlistPage() {
  const { session } = useAppData();
  return <WishlistContent key={`${session.account_type}:${session.user_id}`} />;
}

function WishlistContent() {
  const { allGames, isLive, isLoading, session } = useAppData();
  const wishlist = useWishlist(isLive);
  const [catalogue, setCatalogue] = useState<WishlistGame[]>([]);
  const [catalogueLoading, setCatalogueLoading] = useState(true);
  const [catalogueError, setCatalogueError] = useState("");
  const [catalogueAttempt, setCatalogueAttempt] = useState(0);
  const [mode, setMode] = useState<WishlistMode>("for-you");
  const [shuffleSeed, setShuffleSeed] = useState(0);
  const [previousBatch, setPreviousBatch] = useState<number[]>([]);
  const [picks, setPicks] = useState<WishlistPick[]>([]);
  const [queuedPicks, setQueuedPicks] = useState<WishlistPick[]>([]);
  const [cheapLoading, setCheapLoading] = useState(false);
  const [cheapError, setCheapError] = useState("");
  const [libraryLoaded, setLibraryLoaded] = useState(!isLive);
  const [country, setCountry] = useState("GB");
  const searchInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState("");
  const [searchResults, setSearchResults] = useState<WishlistGame[] | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [selected, setSelected] = useState<{ game: WishlistGame; context: WishlistInteractionContext; reason?: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const searchController = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORE_REGION_KEY);
      // Restore a browser preference after SSR without overwriting it with GB.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (isSteamStoreCountry(stored)) setCountry(steamPriceMarket(stored).code);
    } catch { /* Region selection still works when browser storage is blocked. */ }
  }, []);

  function chooseCountry(nextCountry: string) {
    setCountry(nextCountry);
    try { localStorage.setItem(STORE_REGION_KEY, nextCountry); }
    catch { /* Keep the selected region for this visit if persistence fails. */ }
    trackEvent(ANALYTICS_EVENTS.wishlistAction, { action: "store_region_changed", country: nextCountry });
  }

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setCatalogueLoading(true); setCatalogueError("");
      try {
        const data = await requestJson<CataloguePayload<WishlistGame>>("/wishlist-catalogue?format=compact-v1", { signal: controller.signal });
        setCatalogue(decodeCatalogue(data));
        setShuffleSeed(crypto.getRandomValues(new Uint32Array(1))[0] || 1);
      } catch {
        if (!controller.signal.aborted) setCatalogueError("Recommendations are taking a break. You can still search Steam and use your wishlist.");
      } finally { if (!controller.signal.aborted) setCatalogueLoading(false); }
    }
    void load();
    return () => controller.abort();
  }, [catalogueAttempt]);
  useEffect(() => () => searchController.current?.abort(), []);
  useEffect(() => {
    // Latch the first completed library load so a later background refresh
    // cannot reshuffle a deck that the person is currently browsing.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!isLoading) setLibraryLoaded(true);
  }, [isLoading]);

  const library = isLive ? allGames : EMPTY_LIBRARY;
  const savedIds = useMemo(() => new Set(wishlist.appIds), [wishlist.appIds]);
  const { enrich, detailsClient } = useWishlistDetails([
    ...(selected ? [selected.game.appId] : []),
    ...(searchResults ?? []).map((game) => game.appId),
    ...picks.map((pick) => pick.game.appId),
    ...queuedPicks.slice(0, WISHLIST_PICK_COUNT).map((pick) => pick.game.appId),
    ...wishlist.games.map((game) => game.appId),
  ], country);
  const seenPicks = useRef(new Set<number>());
  const pickHistory = useRef(new Map<string, Set<number>>());
  const historyLoaded = useRef(false);
  const historyStorageKey = wishlistHistoryStorageKey(isLive ? `${session.account_type}:${session.user_id}` : "guest");
  function rememberPicks(next: WishlistPick[]) {
    const raw = rememberWishlistPicks(pickHistory.current, `${mode}:${country}`, next.map(pick => pick.game.appId));
    try { localStorage.setItem(historyStorageKey, raw); } catch { /* Keep visit history when storage is blocked. */ }
  }
  const [shownCount, setShownCount] = useState(0);
  useEffect(() => {
    if (catalogueLoading || catalogueError || !wishlist.ready || !libraryLoaded) return;
    const controller = new AbortController();
    async function prepare() {
      // A deck is a snapshot: saving a card changes its button and the saved
      // shelf, never the cards around it. Only a filter or shuffle replaces it.
      setCheapError("");
      setCheapLoading(mode === "cheap");
      if (!historyLoaded.current) {
        try { pickHistory.current = readWishlistPickHistory(localStorage.getItem(historyStorageKey)); } catch { /* Storage is optional. */ }
        historyLoaded.current = true;
      }
      const historyKey = `${mode}:${country}`;
      seenPicks.current = pickHistory.current.get(historyKey) ?? new Set<number>();
      pickHistory.current.set(historyKey, seenPicks.current);
      const source = catalogue;
      if (mode === "cheap") {
        const startedAt = performance.now();
        let published = false;
        function budgetCandidates(unseen: boolean) {
          const eligible = catalogue.filter(game => {
            if (savedIds.has(game.appId) || previousBatch.includes(game.appId)
              || (unseen && seenPicks.current.has(game.appId)) || (game.reviews ?? 0) < 500
              || (game.positive ?? 0) / Math.max(1, game.reviews ?? 0) < 0.84) return false;
            const cached = detailsClient.peek(game.appId, country);
            // Already-checked expensive/unavailable games must not keep filling
            // the next scan ahead of deeper, untested bargains.
            return !cached || cheapWishlistBand({ ...game, ...cached, reviews: game.reviews, positive: game.positive }, country) !== null;
          });
          // Historical USD prices guide where to look, never qualify a pick.
          return [
            ...recommendWishlist(eligible.filter(game => game.budgetHint), library, wishlist.games, "for-you", shuffleSeed),
            ...recommendWishlist(eligible.filter(game => !game.budgetHint), library, wishlist.games, "for-you", shuffleSeed),
          ].slice(0, WISHLIST_BUDGET_SCAN);
        }
        let candidates = budgetCandidates(true);
        if (candidates.length < WISHLIST_PICK_COUNT && seenPicks.current.size) {
          seenPicks.current.clear();
          candidates = budgetCandidates(false);
        }
        const priced = new Map<number, WishlistGame>();
        function addDetails(game: WishlistGame, details: Partial<WishlistGame>) {
          priced.set(game.appId, { ...game, ...details, title: game.title, tags: game.tags, reviews: game.reviews, positive: game.positive });
        }
        for (const { game } of candidates) {
          const cached = detailsClient.peek(game.appId, country);
          if (cached) addDetails(game, cached);
        }
        function publish(complete = false) {
          const source = [...priced.values()];
          // Keep the £10 preference: use the £20 fallback only after the scan.
          if (!complete && source.filter(game => cheapWishlistBand(game, country) === 1).length < WISHLIST_PICK_COUNT) return;
          const deck = recommendWishlist(source, library, wishlist.games, mode, shuffleSeed, country);
          if (!published) {
            const first = deck.slice(0, WISHLIST_PICK_COUNT);
            rememberPicks(first);
            setPicks(first);
            setShownCount(first.length ? 1 : 0);
            setCheapLoading(false);
            published = true;
            trackEvent(ANALYTICS_EVENTS.wishlistAction, { action: "cheap_picks_ready", recommendation_mode: mode, duration_ms: Math.round(performance.now() - startedAt), candidate_count: priced.size, country });
          }
          // Warming more prices never replaces the set being viewed or saved.
          setQueuedPicks(deck.filter(pick => !seenPicks.current.has(pick.game.appId)));
        }
        publish();
        try {
          const missing = candidates.filter(({ game }) => !priced.has(game.appId));
          for (let start = 0; start < missing.length; start += 4) {
            if (controller.signal.aborted) return;
            if ([...priced.values()].filter(game => cheapWishlistBand(game, country) === 1).length >= WISHLIST_BUDGET_RESERVE) break;
            // One server concurrency group at a time; don't hold the first
            // nine picks behind four waves in a 16-game response.
            const batch = missing.slice(start, start + 4);
            const response = await detailsClient.load(batch.map(pick => pick.game.appId), country);
            if (controller.signal.aborted) return;
            const details = new Map(response.map(game => [game.appId, game]));
            batch.forEach(({ game }) => addDetails(game, details.get(game.appId) ?? {}));
            publish();
          }
          if (controller.signal.aborted) return;
          publish(true);
          trackEvent(ANALYTICS_EVENTS.wishlistAction, { action: "cheap_candidates_loaded", recommendation_mode: mode, candidate_count: priced.size, affordable_count: [...priced.values()].filter(game => cheapWishlistBand(game, country) !== null).length, duration_ms: Math.round(performance.now() - startedAt), country });
        } catch {
          if (controller.signal.aborted) return;
          // A failed background top-up must not remove already usable picks.
          if (!published) setCheapError("Budget picks are unavailable right now. Try again in a moment.");
          setCheapLoading(false);
        }
        return;
      }
      if (controller.signal.aborted) return;
      const eligible = source.filter(game => !savedIds.has(game.appId) && !previousBatch.includes(game.appId));
      let deck = recommendWishlist(eligible.filter(game => !seenPicks.current.has(game.appId)), library, wishlist.games, mode, shuffleSeed, country);
      if (deck.length < WISHLIST_PICK_COUNT && seenPicks.current.size) {
        seenPicks.current.clear();
        deck = recommendWishlist(eligible, library, wishlist.games, mode, shuffleSeed, country);
      }
      rememberPicks(deck.slice(0, WISHLIST_PICK_COUNT));
      setPicks(deck.slice(0, WISHLIST_PICK_COUNT));
      setQueuedPicks(deck.slice(WISHLIST_PICK_COUNT));
      setShownCount(deck.length ? 1 : 0);
      setCheapLoading(false);
    }
    void prepare();
    return () => controller.abort();
    // The key deliberately omits changing saves and live metadata. Their next
    // values are used only after the user chooses a new filter or shuffles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogueAttempt, catalogue, catalogueLoading, catalogueError, wishlist.ready, libraryLoaded, mode, country, shuffleSeed]);


  async function search(event: FormEvent) {
    event.preventDefault();
    const term = query.trim();
    if (term.length < 2) return;
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setSearchBusy(true); setSearchError(""); setSearched(term); setSearchResults(null);
    const startedAt = performance.now();
    try {
      const result = await requestJson<{ games: WishlistGame[] }>(`/api/wishlist/search?q=${encodeURIComponent(term)}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setSearchResults(result.games);
      trackEvent(ANALYTICS_EVENTS.wishlistSearch, { outcome: "completed", result_count: result.games.length, query_length: term.length, duration_ms: Math.round(performance.now() - startedAt) });
    } catch (cause) {
      if (!controller.signal.aborted) {
        setSearchError(cause instanceof Error ? cause.message : "Steam search is unavailable. Please try again.");
        trackEvent(ANALYTICS_EVENTS.wishlistSearch, { outcome: "failed", query_length: term.length, duration_ms: Math.round(performance.now() - startedAt) });
      }
    } finally { if (!controller.signal.aborted) setSearchBusy(false); }
  }

  function renderCard(game: WishlistGame, context: WishlistInteractionContext, reason?: string, eager = false) {
    return <WishlistCard key={game.appId} game={enrich(game)} context={context} reason={reason} eager={eager} saved={savedIds.has(game.appId)} owned={wishlistOwned(game, library)} disabled={!wishlist.ready || wishlist.loading || wishlist.busy} busy={wishlist.pending?.appId === game.appId} onToggle={(item) => void wishlist.toggle(item, context)} onOpen={() => { setSelected({ game, context, reason }); trackEvent(ANALYTICS_EVENTS.wishlistAction, { ...context, action: "game_preview_opened", steam_appid: game.appId, control: "card" }); }} />;
  }

  function changeMode(nextMode: WishlistMode) {
    if (nextMode === mode) return;
    trackEvent(ANALYTICS_EVENTS.wishlistAction, { action: "recommendation_filter_changed", previous_mode: mode, recommendation_mode: nextMode });
    setMode(nextMode); setPreviousBatch([]);
  }

  function openImport() {
    if (!importOpen) trackEvent(ANALYTICS_EVENTS.wishlistAction, { action: "import_panel_opened", connection_required: !isLive });
    setImportOpen((value) => !value);
  }

  function showMore(control: "top" | "bottom") {
    if (cheapLoading) return;
    const eligible = queuedPicks.filter((pick) => !savedIds.has(pick.game.appId) && !wishlistOwned(pick.game, library));
    trackEvent(ANALYTICS_EVENTS.wishlistAction, { action: "recommendations_refreshed", recommendation_mode: mode, page: shownCount + 1, control });
    if (eligible.length < WISHLIST_PICK_COUNT) {
      setPreviousBatch(picks.map((pick) => pick.game.appId));
      setShuffleSeed(crypto.getRandomValues(new Uint32Array(1))[0] || 1);
    } else {
      rememberPicks(eligible.slice(0, WISHLIST_PICK_COUNT));
      setPicks(eligible.slice(0, WISHLIST_PICK_COUNT));
      setQueuedPicks(eligible.slice(WISHLIST_PICK_COUNT));
      setShownCount((value) => value + 1);
    }
  }

  return <div className={styles.page} data-vault-controls="standard">
    <h1 className="visually-hidden">Wishlist</h1>
    <WishlistDetailsDrawer game={selected ? enrich(selected.game) : null} context={selected?.context ?? { surface: "recommendations" }} saved={selected ? savedIds.has(selected.game.appId) : false} owned={selected ? wishlistOwned(selected.game, library) : false} disabled={!wishlist.ready || wishlist.loading || wishlist.busy} busy={Boolean(selected && wishlist.pending?.appId === selected.game.appId)} onToggle={game => { if (selected) void wishlist.toggle(game, selected.context); }} onClose={() => setSelected(null)} />
    {!isLive ? <GuestPreviewNotice feature="Wishlist" icon="heart">Explore purchase recommendations and save games in this browser. Connect your Steam library for personal picks that exclude the games you already own.</GuestPreviewNotice> : null}
    <div className={styles.toolbar}>
      <p>Find something worth adding to your library.</p>
      <div className={styles.toolbarActions}>
        <WishlistRegionMenu value={country} onChange={chooseCountry} />
        <button data-vault-control="steam" className={styles.primaryButton} type="button" disabled={!wishlist.ready || wishlist.busy || wishlist.loading} onClick={openImport} aria-expanded={importOpen} aria-controls="steam-import-panel"><VaultIcon name="open-steam" size={17} />Import Steam wishlist</button>
      </div>
    </div>

    {importOpen ? <section id="steam-import-panel" className={styles.importPanel} aria-label="Import Steam wishlist">
      <div><h2>Bring your Steam wishlist along.</h2><p>{isLive ? `Import the public wishlist for ${session.steam_display_name || session.display_name}. This adds entries to VaultShuffle, keeps existing saves, and never changes your Steam wishlist.` : "Connect your Steam profile to import its public wishlist and save games to your VaultShuffle account."}</p></div>
      {isLive ? <div className={styles.importControls}><p>Steam’s <strong>My profile</strong> and <strong>Game details</strong> must both be Public. Signing in does not grant access to a private wishlist.</p><a data-vault-control="text" className={styles.storeLink} href="https://steamcommunity.com/my/edit/settings" target="_blank" rel="noreferrer">Open Steam privacy settings <VaultIcon name="external-link" size={14} /></a><button data-vault-control="steam" aria-busy={wishlist.pending?.operation === "import"} className={styles.primaryButton} disabled={!wishlist.ready || wishlist.busy || wishlist.loading} onClick={() => void wishlist.importSteam()}>{wishlist.pending?.operation === "import" ? <><span data-control-spinner aria-hidden="true" />Importing…</> : "Import now"}</button></div> : <Link data-vault-control="steam" className={styles.primaryButton} href="/setup/steam-profile?from=wishlist" onClick={() => trackNavigationEvent(ANALYTICS_EVENTS.wishlistAction, { action: "profile_connection_started", entry_point: "wishlist_import" })}>Connect Steam profile <VaultIcon name="chevron-right" size={16} /></Link>}
    </section> : null}

    {wishlist.importSummary ? <p className={styles.importSummary} role="status">{wishlist.importSummary}</p> : null}

    <form className={styles.search} onSubmit={search} role="search" aria-label="Steam store">
      <div className={styles.searchField}><VaultIcon name="search" size={20} /><label className={styles.srOnly} htmlFor="steam-search">Search the Steam store</label><input ref={searchInput} id="steam-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search the Steam store…" minLength={2} maxLength={100} required /></div>
      <button data-vault-control="primary" aria-busy={searchBusy} className={styles.primaryButton} disabled={searchBusy || query.trim().length < 2} type="submit">{searchBusy ? <><span data-control-spinner aria-hidden="true" />Searching…</> : "Search"}</button>
    </form>

    {wishlist.error ? <div className={styles.error} role="alert"><span>{wishlist.error}</span><button data-vault-control="secondary" aria-busy={wishlist.loading} onClick={() => void wishlist.reload()} disabled={wishlist.busy || wishlist.loading}>{wishlist.loading ? <><span data-control-spinner aria-hidden="true" />Reloading…</> : "Reload wishlist"}</button></div> : null}
    <p className={styles.status} role="status" aria-live="polite">{wishlist.notice || (wishlist.busy ? "Updating your wishlist…" : "")}</p>

    {searched ? <section className={styles.section} aria-labelledby="search-results-title" aria-busy={searchBusy}>
      <div className={styles.sectionHeading}><div><h2 id="search-results-title">Results for “{searched}”</h2><p>Search across Steam. Open a store page for current prices and availability.</p></div><button data-vault-control="tertiary" className={styles.textButton} onClick={() => { searchController.current?.abort(); setSearchBusy(false); setSearched(""); setSearchResults(null); setSearchError(""); }}>Close results <VaultIcon name="close" size={15} /></button></div>
      {searchBusy ? <p className={styles.loading} role="status">Searching Steam…</p> : searchError ? <p className={styles.error} role="alert">{searchError}</p> : searchResults?.length ? <div className={styles.grid}>{searchResults.map((game, index) => renderCard(game, { surface: "search", rank: index + 1 }))}</div> : <p className={styles.emptySmall}>No games found. Try a different title.</p>}
      <a data-vault-control="text" className={styles.storeLink} href={`https://store.steampowered.com/search/?term=${encodeURIComponent(searched)}`} target="_blank" rel="noreferrer" onClick={() => trackNavigationEvent(ANALYTICS_EVENTS.wishlistAction, { action: "steam_search_opened", query_length: searched.length })}>See all results on Steam <VaultIcon name="external-link" size={14} /></a>
    </section> : null}

    <section className={styles.section} aria-labelledby="recommendations-title" aria-busy={catalogueLoading || cheapLoading}>
      <div className={styles.sectionHeading}>
        <div><h2 id="recommendations-title">Worth a spot on your wishlist</h2><p>{mode === "cheap" ? "Well reviewed games at a good price on Steam right now." : isLive ? "New games, drawn from different corners of your playing history." : "Discovery preview. Connect Steam to make these picks personal."}</p></div>
        <div className={styles.recommendationControls}><div className={styles.filters} aria-label="Recommendation style">{([{ id: "for-you", label: "For you" }, { id: "short", label: "Short & sweet" }, { id: "cheap", label: "Budget picks" }, { id: "acclaimed", label: "Highly rated" }] as const).map((filter) => <button data-vault-control="selection" data-control-hover="secondary" data-control-indicator="bar" key={filter.id} aria-pressed={mode === filter.id} onClick={() => changeMode(filter.id)}>{filter.label}</button>)}</div><button data-vault-control="secondary" data-control-size="icon" className={styles.refreshIconButton} type="button" aria-label="Refresh picks" title="Refresh picks" disabled={catalogueLoading || cheapLoading || !picks.length} aria-busy={cheapLoading} onClick={() => showMore("top")}>{cheapLoading ? <span data-control-spinner aria-hidden="true" /> : <VaultIcon name="refresh-data" size={19} />}</button></div>
      </div>
      {catalogueLoading || (cheapLoading && !picks.length) ? <div className={styles.grid} aria-label="Loading recommendations">{Array.from({ length: WISHLIST_PICK_COUNT }, (_, index) => <div key={index} className={styles.skeleton} />)}</div> : catalogueError || cheapError ? <div className={styles.error}><p>{catalogueError || cheapError}</p><button data-vault-control="secondary" onClick={() => { if (cheapError) setShuffleSeed(crypto.getRandomValues(new Uint32Array(1))[0] || 1); else setCatalogueAttempt((value) => value + 1); }}>Try again</button></div> : picks.length ? <div className={styles.grid}>{picks.map((pick, index) => renderCard(pick.game, { surface: "recommendations", recommendation_mode: mode, rank: (shownCount - 1) * WISHLIST_PICK_COUNT + index + 1 }, pick.reason, index === 0))}</div> : <p className={styles.emptySmall}>No new matches in this selection. Try another style or search Steam above.</p>}
      {!catalogueLoading && !catalogueError && !cheapError && picks.length ? <div className={styles.moreRow}><button data-vault-control="secondary" className={styles.shuffleButton} type="button" disabled={cheapLoading} aria-busy={cheapLoading} onClick={() => showMore("bottom")}>{cheapLoading ? <span data-control-spinner aria-hidden="true" /> : <VaultIcon name="refresh-data" size={17} />}{cheapLoading ? "Finding picks…" : "Refresh picks"}</button></div> : null}
    </section>

    <section className={`${styles.section} ${styles.savedSection}`} aria-labelledby="saved-title" aria-busy={wishlist.loading}>
      <div className={styles.sectionHeading}><div><h2 id="saved-title">Your wishlist <span className={styles.count}>{wishlist.appIds.length}</span></h2><p>{isLive ? "Saved to your VaultShuffle profile. Use Steam for prices, purchases and Steam wishlist changes." : "Saved in this browser. Connect a Steam profile for an account wishlist and imports."}</p></div>{isLive ? <a data-vault-control="text" className={styles.storeLink} href={`https://store.steampowered.com/wishlist/profiles/${session.steam_id}/`} target="_blank" rel="noreferrer" onClick={() => trackNavigationEvent(ANALYTICS_EVENTS.wishlistAction, { action: "steam_wishlist_opened" })}>Your Steam wishlist <VaultIcon name="external-link" size={14} /></a> : null}</div>
      {wishlist.loading ? <p className={styles.loading}>Loading your wishlist…</p> : wishlist.games.length ? <><div className={styles.grid}>{wishlist.games.map((game, index) => renderCard(game, { surface: "wishlist", rank: index + 1 }))}</div>{wishlist.games.length < wishlist.appIds.length ? <button data-vault-control="secondary" aria-busy={wishlist.pending?.operation === "load_more"} className={styles.loadMore} disabled={wishlist.busy} onClick={() => void wishlist.loadMore()}>{wishlist.pending?.operation === "load_more" ? <><span data-control-spinner aria-hidden="true" />Loading games…</> : "Load more saved games"}</button> : null}</> : !wishlist.error ? <div className={styles.empty}><span className={styles.emptyIcon}><VaultIcon name="heart" size={29} /></span><h3>Make room for your next favourite.</h3><p>Import your Steam wishlist or start adding games you discover here.</p><button data-vault-control="tertiary" className={styles.textButton} onClick={() => { searchInput.current?.scrollIntoView({ behavior: "instant", block: "center" }); searchInput.current?.focus({ preventScroll: true }); trackEvent(ANALYTICS_EVENTS.wishlistAction, { action: "find_first_game" }); }}>Find your first game <VaultIcon name="chevron-right" size={15} /></button></div> : null}
    </section>
  </div>;
}
