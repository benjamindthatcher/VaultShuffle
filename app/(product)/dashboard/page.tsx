"use client";

import { useEffect, useMemo, useState } from "react";
import { LibraryDetailsDrawer } from "@/components/library/LibraryDetailsDrawer";
import Link from "next/link";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { GuestPreviewNotice } from "@/components/guest/GuestPreviewNotice";
import { useCompletionClaimNotice } from "@/components/shared/CompletionClaimBanner";
import { NoticeStack } from "@/components/shared/NoticeStack";
import { useWelcomeBackNotice } from "@/components/shared/WelcomeBack";
import { FinishedGameCard } from "@/components/dashboard/FinishedGameCard";
import { CompletionHistory } from "@/components/dashboard/CompletionHistory";
import { completionHistory } from "@/lib/completion-history";
import { useV2Dashboard } from "@/components/dashboard/useV2Dashboard";
import { useV2Library } from "@/components/library/useV2Library";
import { dashboardStats } from "@/lib/v2/dashboard-view-model";
import { libraryGame } from "@/lib/v2/library-view-model";
import { globalFilterParams } from "@/lib/v2/filter-query";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { VaultShuffleLoader } from "@/components/shared/VaultShuffleLoader";
import { LibraryOverview } from "@/components/dashboard/LibraryOverview";
import { buildBacklogStats, formatMoney } from "@/lib/backlog-stats";
import { LOCAL_DASHBOARD_PREVIEW } from "@/lib/dashboard-preview";
import { PageHeading } from "@/components/shared/PageHeading";
import { StatCard, StatPanel } from "@/components/shared/StatCard";
import { GlobalFiltersPanel } from "@/components/dashboard/GlobalFiltersPanel";
import { FamilySharingCard } from "@/components/family/FamilySharingCard";
import { SectionHeading } from "@/components/shared/SectionHeading";
import type { DemoGame } from "@/lib/demo-data";
import { ManagePinsDialog } from "@/components/shared/ManagePinsDialog";
import { PinnedCommitments } from "@/components/shared/PinnedCommitments";
import { formatGameDuration } from "@/lib/game-duration";
import styles from "./dashboard.module.css";
import { FamilyGameMark } from "@/components/shared/FamilyMark";

type DashboardDetailsSurface = "dashboard_guest" | "dashboard_pinned" | "dashboard_value" | "dashboard_finished";

export default function DashboardPage() {
  const { games, allGames, collections, isLive, isLoading, steamImport, steamImportChecked, vaultState, recordVaultAction, updateGame: saveGame, restoreGame: reactivateGame, setGameCollection, dataAuthority, libraryDataVersion, globalFilters, rememberLibraryGames, unfilteredGameCount, unfilteredFamilyCount } = useAppData();

  // Every game on this page names a game, so every game on this page opens it.
  // These were flat tiles: the dashboard could tell you Palworld was your best
  // value for money and then offer no way to look at it.
  const [detailsGameId, setDetailsGameId] = useState<string | null>(null);
  const [detailsSurface, setDetailsSurface] = useState<DashboardDetailsSurface | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [pinCandidate, setPinCandidate] = useState<DemoGame | null>(null);
  const v2=isLive && dataAuthority === "v2";
  const remote=useV2Dashboard(v2,globalFilterParams(globalFilters),libraryDataVersion);
  const remoteDetail=useV2Library(false,"",String(libraryDataVersion));
  // Completion history is unfiltered, as in the existing product, and fetched only when opened.
  const history=useV2Library(v2 && historyOpen,"section=completed&sort=recent&direction=desc&limit=60",String(libraryDataVersion));
  const highlights=useMemo(()=>remote.payload?.cards.map(libraryGame)??[],[remote.payload]);
  useEffect(()=>{if(v2 && highlights.length)rememberLibraryGames(highlights);},[v2,highlights,rememberLibraryGames]);
  const detailsGame = v2 ? remoteDetail.detail?.id === detailsGameId ? remoteDetail.detail : null
    : detailsGameId ? games.find(game=>game.id===detailsGameId)??allGames.find(game=>game.id===detailsGameId)??null : null;

  function openDetails(gameId: string, surface: DashboardDetailsSurface) {
    setDetailsGameId(gameId);
    setDetailsSurface(surface);
    if(v2)void remoteDetail.openDetail(gameId);
  }
  async function updateGame(id:string, patch:Parameters<typeof saveGame>[1]) {
    await saveGame(id,patch);
    if(v2 && id===detailsGameId)await remoteDetail.openDetail(id);
  }
  async function restoreGame(id:string) {
    await reactivateGame(id);
    if(v2 && id===detailsGameId)await remoteDetail.openDetail(id);
  }

  function closeDetails() {
    remoteDetail.closeDetail();
    setDetailsGameId(null);
    setDetailsSurface(null);
  }
  const completionNotice = useCompletionClaimNotice(remote.payload);
  const welcomeNotice = useWelcomeBackNotice(remote.payload);

  const stats = useMemo(() => v2 && remote.payload ? dashboardStats(remote.payload) : buildBacklogStats(games), [v2,remote.payload,games]);

  const recentCompletions = useMemo(() => v2 ? highlights.filter(game=>remote.payload?.recentCompletions.some(item=>item.gameId===Number(game.id))).sort((a,b)=>(b.completedAt??"").localeCompare(a.completedAt??"")).slice(0,4) : completionHistory(games).slice(0,4),[v2,highlights,remote.payload,games]);
  const allCompletions = useMemo(() => v2 ? history.games : completionHistory(allGames), [v2,history.games,allGames]);

  const bestValueGames = useMemo(
    () => v2 ? (remote.payload?.bestValueGames.flatMap(item=>{const game=highlights.find(game=>Number(game.id)===item.game.gameId);return game?[{game,cents:item.cents,centsPerHour:item.centsPerHour}]:[];})??[]) : games
      .filter((game) => game.ownership === "Owned" && game.hoursPlayed >= 1 && Number(game.priceInitial ?? 0) > 0)
      .map((game) => ({ game, cents: Number(game.priceInitial), centsPerHour: Number(game.priceInitial) / game.hoursPlayed }))
      .sort((left, right) => left.centsPerHour - right.centsPerHour)
      .slice(0, 5),
    [games,v2,remote.payload,highlights]
  );

  const guestSummary = useMemo(() => ({
    genres: new Set(games.flatMap((game) => game.genres)).size,
    timed: games.filter((game) => formatGameDuration(game.duration)).length,
    reviewed: games.filter((game) => Number(game.reviewTotal ?? 0) > 0).length,
    // Three across, four down.
    featured: games.slice(0, 12)
  }), [games]);

  // Declared once and rendered by both branches: the guest view returns
  // early, so a panel written only into the signed-in tree never mounts for a
  // guest and their cards would open nothing.
  // It is the same panel the Library opens, so a game looks and behaves the
  // same wherever it is met.
  const detailsPanel = (
    <>
    {v2 && remoteDetail.detailPending ? <p role="status">Loading game details…</p> : null}
    {v2 && remoteDetail.error ? <p role="alert">{remoteDetail.error}</p> : null}
    <LibraryDetailsDrawer
      game={detailsGame}
      previewMode={!isLive}
      variant={detailsSurface === "dashboard_pinned" ? "pinned" : "library"}
      pin={(vaultState.pins ?? []).find((entry) => entry.gameId === detailsGame?.id)}
      collections={collections}
      saving={savingNotes}
      onSave={async (patch) => {
        if (!detailsGame) return;
        setSavingNotes(true);
        try {
          await updateGame(detailsGame.id, patch);
        } finally {
          setSavingNotes(false);
        }
      }}
      onToggleCollection={async (collectionId, assigned) => {
        if (!detailsGame) return;
        await setGameCollection(detailsGame.id, collectionId, assigned);
      }}
      onClose={closeDetails}
      pinSlot={detailsGame ? vaultState.pinnedIds.indexOf(detailsGame.id) + 1 || null : null}
      pinCount={vaultState.pinnedIds.length}
      onTogglePin={() => {
        if (!detailsGame) return;
        if (!vaultState.pinnedIds.includes(detailsGame.id) && vaultState.pinnedIds.length >= 3) { setPinCandidate(detailsGame); return; }
        const removingSpotlight = detailsSurface === "dashboard_pinned" && vaultState.pinnedIds.includes(detailsGame.id);
        void recordVaultAction(vaultState.pinnedIds.includes(detailsGame.id) ? "unpinned" : "pinned", detailsGame.id)
          .then(() => { if (removingSpotlight) closeDetails(); }).catch(() => {});
      }}
      onManagePins={() => { if (detailsGame) setPinCandidate(detailsGame); }}
      onComplete={async () => {
        if (!detailsGame) return;
        await updateGame(detailsGame.id, { status: "Completed", completedAt: new Date().toISOString() });
      }}
      onRestore={async () => {
        if (!detailsGame) return;
        await restoreGame(detailsGame.id);
      }}
      onBlacklist={async () => {
        if (!detailsGame) return;
        await updateGame(detailsGame.id, { status: "Blacklisted", completedAt: null });
      }}
    />
    {pinCandidate ? <ManagePinsDialog
      pinnedGames={vaultState.pinnedIds.map(id => allGames.find(game => game.id === id)).filter((game): game is DemoGame => Boolean(game))}
      candidate={pinCandidate}
      onRemove={async id => { await recordVaultAction("unpinned", id); }}
      onReplace={async id => { await recordVaultAction("pinned", pinCandidate.id, { source: "dashboard", replace_game_id: id }); }}
      onClose={() => setPinCandidate(null)}
    /> : null}
    </>
  );

  const localPreview = LOCAL_DASHBOARD_PREVIEW && !isLive;

  if (!isLive && !localPreview) {
    return (
      <div className={styles.page} data-vault-controls="standard">
        <PageHeading title="Dashboard preview" />

        <GuestPreviewNotice feature="Dashboard" icon="details">
          These are catalogue facts, not claims about your library. Connect a public Steam library whenever you want this dashboard to become yours.
        </GuestPreviewNotice>

        <PinnedCommitments games={games} pins={vaultState.pins ?? []} pinnedIds={vaultState.pinnedIds} onSelect={(gameId) => openDetails(gameId, "dashboard_pinned")} onUnpin={(gameId) => { void recordVaultAction("unpinned", gameId).catch(() => {}); }} showEmpty compactEmpty />

        <>
            <section className={styles.hero}>
              <p className={styles.heroLabel}>Guest catalogue ready</p>
              <p className={styles.heroValue}>{games.length}<span> popular Steam games</span></p>
              <p className={styles.heroHint}>Browse the catalogue, build a preview collection or ask the Vault to choose one.</p>
            </section>

            <StatPanel label="Guest catalogue summary" columns={4}>
              <StatCard label="Catalogue games" value={games.length} note="Popular games available to explore." />
              <StatCard label="Genres represented" value={guestSummary.genres} note="Useful for trying Vault filters." />
              <StatCard label="Time estimates" value={guestSummary.timed} note="Games with a known playthrough length." />
              <StatCard label="Review signals" value={guestSummary.reviewed} note="Games with public Steam review data." />
            </StatPanel>
        </>

        <section className={styles.section}>
          <SectionHeading title="A look inside the guest catalogue" />
          <ol className={`${styles.cardGrid} ${styles.guestGrid}`}>
            {guestSummary.featured.map((game) => (
              <li key={game.id} className={styles.gameCard} data-vault-card="interactive">
                <button type="button" className={styles.cardOpen} data-vault-card-trigger onClick={() => openDetails(game.id, "dashboard_guest")} aria-label={`Open ${game.title}`} />
                <span className={styles.cardArt}><Artwork src={game.bannerUrl} sizes="(max-width: 760px) 45vw, 240px" /><FamilyGameMark game={game} overlay /></span>
                <strong className={styles.cardTitle}>{game.title}</strong>
                <small className={styles.cardMeta}>{game.genres.slice(0, 3).join(" · ") || "Steam catalogue"}</small>
                <span className={styles.cardValue}>{formatGameDuration(game.duration) ?? "Length unknown"}</span>
              </li>
            ))}
          </ol>
          <Link
            data-vault-control="primary" className={styles.centredAction}
            href="/vault"
          >
            Try a Vault draw<VaultIcon name="chevron-right" size={16} />
          </Link>
        </section>

        {detailsPanel}
      </div>
    );
  }

  const awaitingFirstLibrary = !localPreview && (v2 ? unfilteredGameCount === 0 : games.length === 0) && (
    isLoading
    || !steamImportChecked
    || steamImport.status === "idle"
    || steamImport.status === "fetching"
    || steamImport.status === "importing"
    || steamImport.status === "failed"
  );

  return (
    <div className={styles.page} data-vault-controls="standard">
      <h1 className="visually-hidden">Dashboard</h1>

      {localPreview ? (
        <GuestPreviewNotice feature="Dashboard" icon="details">
          Local design preview — all dashboard modules are visible. Playtime, completions and family members use sample data. Filters and game changes work locally and reset on reload.
        </GuestPreviewNotice>
      ) : null}

      {awaitingFirstLibrary ? null : (
        <>
          {/* The only place in the app that carries these. Everywhere else is
              for doing one thing, and a strip asking you to go and do something
              else at the top of it was in the way. Still capped and ordered:
              something to action, then ambient news. */}
          <NoticeStack
            notices={[
              { id: "completion", node: completionNotice },
              { id: "welcome", node: welcomeNotice }
            ]}
          />

          {/* Above everything but the notices. What you said you would play next
              is the one thing here you might act on tonight; the library's value
              and its stats are a standing report that keeps. */}
          <PinnedCommitments
            games={v2 ? allGames : games}
            pins={vaultState.pins ?? []}
            pinnedIds={vaultState.pinnedIds}
            onSelect={(gameId) => openDetails(gameId, "dashboard_pinned")}
            onUnpin={(gameId) => { void recordVaultAction("unpinned", gameId).catch(() => {}); }}
            compact
            showEmpty
            compactEmpty
            emptySlotLabel="Let Vault find something worth playing."
          />

          {v2 && remote.pending ? <VaultShuffleLoader active inline label="Loading your dashboard" /> : null}
          {v2 && remote.error ? <p role="alert">{remote.error} <button type="button" data-vault-control="secondary" onClick={remote.retry}>Retry</button></p> : null}
          {!v2 || remote.payload ? <LibraryOverview stats={stats} /> : null}

          {/* These filters also govern the overview above. */}
          <GlobalFiltersPanel filteredCount={v2 ? remote.payload ? remote.payload.aggregates.ownedGames+remote.payload.aggregates.familyGames : null : undefined}
            familyCount={v2 ? unfilteredFamilyCount : undefined} exclusionIds={v2 ? remote.payload?.availableExclusions ?? [] : undefined} />

          {/* Sits with the filters rather than in an account screen: both answer
              "what is even on the table", and adding a family member changes the
              pool the same way a filter does. Renders nothing at all unless
              NEXT_PUBLIC_FAMILY_SHARING is set - see lib/family-flag.ts. */}
          <FamilySharingCard preview={localPreview} />

          {bestValueGames.length ? (
            <section className={styles.section}>
              <SectionHeading title="Most value for money" />
              <ol className={styles.podium}>
                {bestValueGames.slice(0, 3).map(({ game, cents, centsPerHour }, index) => (
                  <li key={game.id} className={styles.podiumCard} data-vault-card="interactive" data-place={index + 1}>
                    <button type="button" className={styles.cardOpen} data-vault-card-trigger onClick={() => openDetails(game.id, "dashboard_value")} aria-label={`Open ${game.title}`} />
                    <span className={styles.cardArt}><Artwork src={game.bannerUrl} sizes="(max-width: 760px) 45vw, 300px" /><FamilyGameMark game={game} overlay /></span>
                    <span className={styles.podiumHeading}>
                      <span className={styles.place}>
                        <VaultIcon name="trophy" size={18} />
                        {index === 0 ? "1st" : index === 1 ? "2nd" : "3rd"}
                      </span>
                      <strong className={styles.cardTitle} title={game.title}>{game.title}</strong>
                    </span>
                    <span className={styles.podiumMetrics}>
                      <span className={styles.cardValue}>{formatMoney(Math.round(centsPerHour), stats.currency)}<small>/hour</small></span>
                      <small className={styles.cardMeta}>{Math.round(game.hoursPlayed)}h from {formatMoney(cents, stats.currency)}</small>
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {!v2 || remote.payload ? <section className={styles.section}>
            <SectionHeading title="Recently finished" action={<button type="button" data-vault-control="tertiary" className={styles.historyAction} aria-expanded={historyOpen} aria-controls="completion-history-panel" onClick={() => setHistoryOpen((open) => !open)}><VaultIcon name="clock" size={16} />Completion history <VaultIcon name="chevron-down" size={16} /></button>} />
            {historyOpen ? <CompletionHistory games={allCompletions} currency={stats.currency} onSelect={(id) => openDetails(id, "dashboard_finished")}
              total={v2 ? history.page?.total : undefined} loadMore={v2 && history.page?.nextCursor ? history.loadMore : undefined}
              pending={v2 && history.pending} error={v2 ? history.error : null} retry={history.retry} /> : null}
            {recentCompletions.length ? (
              <ol className={styles.finishedGrid}>
                {recentCompletions.map((game) => <FinishedGameCard key={game.id} game={game} currency={stats.currency} onSelect={(id) => openDetails(id, "dashboard_finished")} />)}
              </ol>
            ) : (
              <div className={styles.empty}>
                <p><strong>Nothing finished yet.</strong> The bar above fills every time you complete something.</p>
                <Link data-vault-control="primary" className={styles.emptyAction} href="/vault">Draw something to play</Link>
              </div>
            )}
          </section> : null}


        </>
      )}

      {detailsPanel}
    </div>
  );
}
