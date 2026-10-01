"use client";

import Image from "next/image";
import Link from "next/link";
import { useRef, useState, type CSSProperties } from "react";
import { Artwork } from "@/components/shared/Artwork";
import { VaultIcon, type VaultIconName } from "@/components/shared/VaultIcon";
import { steamHeaderImage } from "@/lib/steam-images";
import header from "@/components/app-shell/AppHeader.module.css";
import { filterGroups, paletteRoles, sampleGames, themes } from "./themes";
import styles from "./theme-workshop.module.css";

type SampleGame = typeof sampleGames[number];
const finishedGames = [sampleGames[2], sampleGames[3], sampleGames[1], sampleGames[4]];
const navItems = ["Dashboard", "Vault", "Library", "Collections", "Wishlist"];

function Icon({ name }: { name: VaultIconName }) {
  return <span className={styles.icon}><VaultIcon name={name} size={22} /></span>;
}

export function ThemeWorkshop({ initialTheme }: { initialTheme: number }) {
  const [themeIndex, setThemeIndex] = useState(initialTheme);
  const [filters, setFilters] = useState([0, 0, 0, 0]);
  const [hidePoorReviews, setHidePoorReviews] = useState(false);
  const [pinned, setPinned] = useState<SampleGame | null>(null);
  const [selectedGame, setSelectedGame] = useState<SampleGame | null>(null);
  const [saved, setSaved] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const theme = themes[themeIndex];
  const activeFilters = filters.filter(Boolean).length + Number(hidePoorReviews);
  const themeStyle = {
    "--work-ground": theme.ground, "--work-chrome": theme.chrome,
    "--work-surface": theme.surface, "--work-feature": theme.feature,
    "--work-well": theme.well, "--work-border": theme.border,
    "--work-accent": theme.accent, "--work-blue": theme.blue,
    "--work-text": theme.text, "--work-muted": theme.muted,
  } as CSSProperties;

  function chooseTheme(index: number) {
    const next = (index + themes.length) % themes.length;
    setThemeIndex(next);
    setSaved(false);
    const url = new URL(window.location.href);
    url.searchParams.set("theme", themes[next].id);
    window.history.replaceState(null, "", url);
  }

  function openGame(game: SampleGame) {
    setSelectedGame(game);
    dialogRef.current?.showModal();
  }

  function downloadTheme() {
    const tokens = {
      "ink": theme.ground, "bg": theme.ground, "chrome": theme.chrome,
      "surface": theme.surface, "surface-strong": theme.feature, "surface-soft": theme.surface,
      "sheet-surface": theme.surface, "card-surface": theme.surface,
      "feature-surface": theme.feature, "well-surface": theme.well,
      "border": theme.border, "sheet-border": theme.border, "card-border": theme.border,
      "border-strong": theme.accent, "feature-border": theme.accent,
      "accent": theme.accent, "accent-blue": theme.blue,
      "text": theme.text, "text-muted": theme.muted,
      "control-focus": theme.accent,
    };
    const css = `/* VaultShuffle · ${theme.name}\n   Workshop proposal — not an approved global replacement.\n   Keep app/controls.css for semantic action colours and motion.\n   Hardcoded component colours need migration; see docs/theme-workshop.md. */\n:root {\n${Object.entries(tokens).map(([key, value]) => `  --vault-${key}: ${value};`).join("\n")}\n}\n`;
    const url = URL.createObjectURL(new Blob([css], { type: "text/css" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `vaultshuffle-${theme.id}.css`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSaved(true);
  }

  function gameCard(game: SampleGame, index: number, finished = false) {
    return <li key={game.id} className={styles.gameCard} data-vault-card="interactive">
      <button type="button" className={styles.cardTrigger} data-vault-card-trigger aria-label={`Open ${game.title}${finished ? " completion" : " value"} preview`} onClick={() => openGame(game)} />
      <span className={styles.art}><Artwork src={steamHeaderImage(game.id)} sizes="(max-width: 600px) 90vw, 360px" /></span>
      <div className={styles.cardCopy}>
        <div className={styles.gameTitle}>{!finished ? <span className={styles.rank}>{index + 1}<span>{["ST", "ND", "RD"][index]}</span></span> : null}<h3>{game.title}</h3></div>
        <p className={styles.gameRate}>{game.rate}<span> / hour</span></p>
        <p>{game.hours}h played · {game.price}</p>
        {finished ? <p className={styles.finished}><VaultIcon name="check" size={14} />Finished {game.date}</p> : null}
      </div>
    </li>;
  }

  return <div className={styles.workshop} style={themeStyle} data-theme={theme.id} data-vault-controls="standard">
    <header className={`${header.headerWrap} ${styles.appHeader}`}>
      <div className={header.header}>
        <Link href="/" className={header.brand} aria-label="Vault Shuffle home"><span className={header.brandMark}><Image src="/assets/brand/vaultshuffle-icon.png" width={42} height={42} className={header.brandIcon} alt="" priority /></span><span className={header.brandWordmark}><span className={header.brandWord}>Vault</span><span className={header.brandAccent}>Shuffle</span></span></Link>
        <nav className={header.nav} aria-label="Preview navigation">
          {navItems.map((item, index) => <Link key={item} href={index === 0 ? "#dashboard-preview" : `/${item.toLowerCase()}`} aria-current={index === 0 ? "page" : undefined} className={`${header.navLink} ${index === 0 ? header.navLinkActive : ""}`}>{item}</Link>)}
        </nav>
        <details className={header.profileMenu}><summary className={header.profilePill}><span className={header.profileAvatar}>G</span><span>Guest</span><VaultIcon name="chevron-down" size={14} /></summary><div className={header.profilePopover}><strong>Workshop profile</strong><p className={styles.muted}>All values are sample data. No account changes are made here.</p><Link href="/dashboard" data-vault-control="text">Open current dashboard</Link></div></details>
      </div>
    </header>

    <section className={styles.workbench} aria-label="Theme workshop controls">
      <div className={styles.workbenchInner}>
        <div className={styles.workbenchTitle}><h1>Theme workshop</h1><p>Archived theme concepts. The site now uses its restored purple palette.</p></div>
        <div className={styles.themeChoices} role="group" aria-label="Theme direction">
          {themes.map((item, index) => <button key={item.id} type="button" data-vault-control="selection" data-control-indicator="bar" aria-pressed={themeIndex === index} onClick={() => chooseTheme(index)} className={styles.themeChoice}><span className={styles.miniPalette} aria-hidden="true"><i style={{ background: item.surface }} /><i style={{ background: item.accent }} /><i style={{ background: item.blue }} /></span><span><small>0{index + 1}</small> {item.name}</span></button>)}
        </div>
        <div className={styles.sliderControls}>
          <button type="button" data-vault-control="secondary" aria-label="Previous theme" onClick={() => chooseTheme(themeIndex - 1)}><VaultIcon name="chevron-left" size={18} /></button>
          <div className={styles.rangeWrap}><input type="range" min="0" max="2" step="1" value={themeIndex} onChange={(event) => chooseTheme(Number(event.target.value))} aria-label="Theme slider" aria-valuetext={`${themeIndex + 1} of 3: ${theme.name}`} /><span aria-hidden="true">{themeIndex + 1} / 3</span></div>
          <button type="button" data-vault-control="secondary" aria-label="Next theme" onClick={() => chooseTheme(themeIndex + 1)}><VaultIcon name="chevron-right" size={18} /></button>
        </div>
      </div>
    </section>

    <main id="dashboard-preview" className={styles.main}>
      <section className={styles.direction} aria-label="Selected direction">
        <div aria-live="polite"><h2>{theme.name}<span>{theme.mood}</span></h2><p>{theme.description}</p></div>
        <span className={styles.sampleNote}>Dashboard replica<br /><strong>Sample data · local interactions</strong></span>
      </section>

      <section className={styles.section} aria-labelledby="playing-next-title">
        <div className={styles.sectionHeading}><h2 id="playing-next-title">Playing Next <span>{pinned ? "1" : "0"} of 3</span></h2><span className={styles.spots} aria-label={`${pinned ? 1 : 0} of 3 spots used`}>{[0, 1, 2].map((i) => <i key={i} data-filled={i === 0 && Boolean(pinned)} />)}</span></div>
        <div className={`${styles.queue} ${styles.feature}`}>
          {pinned ? <><span className={styles.queueArt}><Artwork src={steamHeaderImage(pinned.id)} sizes="140px" /></span><div><h3>{pinned.title}</h3><p>Ready when you are. Added to this workshop only.</p></div><button type="button" data-vault-control="secondary" onClick={() => setPinned(null)}>Clear preview</button></> : <><Icon name="played" /><div><h3>Nothing lined up yet</h3><p>Let the Vault find something worth playing.</p></div><button type="button" data-vault-control="primary" onClick={() => setPinned(sampleGames[0])}>Find your first game<VaultIcon name="chevron-right" size={17} /></button></>}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="overview-title">
        <div className={styles.sectionHeading}><div><h2 id="overview-title">Your library at a glance</h2><p>A quick overview of your games at a glance.</p></div><Link href="/library" data-vault-control="secondary" className={styles.action}>View library<VaultIcon name="chevron-right" size={16} /></Link></div>
        <div className={styles.overview}>
          <div className={`${styles.valuePanel} ${styles.feature}`}><div><p>Library value completed</p><strong>$140</strong><p>of <b>$18,400</b> library value</p><div className={styles.valueRule}><span /></div><small>Every finished game counts.</small></div><div className={styles.ring} role="img" aria-label="1 percent of library value recovered"><svg viewBox="0 0 140 140" aria-hidden="true"><circle cx="70" cy="70" r="59" className={styles.track} /><circle cx="70" cy="70" r="59" className={styles.progress} strokeDasharray="3.71 370.71" /></svg><div><strong>1<span>%</span></strong><small>RECOVERED</small></div></div></div>
          <div className={styles.stats}>
            {([
              ["playtime", "Hours played", "542", "across the whole library"],
              ["completed", "Games completed", "4", "of 1,000 games in your library"],
              ["backlog", "Never opened", "992", "worth $18,120"],
              ["price", "Best value", "$0.22", "an hour · HELLDIVERS™ 2"],
            ] as const).map(([icon, label, value, note]) => <article key={label} className={styles.stat}><Icon name={icon} /><div><p>{label}</p><strong>{value}</strong><small>{note}</small></div></article>)}
          </div>
        </div>
      </section>

      <section className={styles.panel} aria-labelledby="filter-title">
        <div className={styles.sectionHeading}><div><h2 id="filter-title"><VaultIcon name="filter" size={18} />Global filters</h2><p>Try selected states. Sample statistics stay fixed for a fair theme comparison.</p></div><span className={styles.count} aria-live="polite">{activeFilters ? `${activeFilters} preview filters` : "1,000 sample games"}</span></div>
        <div className={styles.filters}>{filterGroups.map((group, groupIndex) => <fieldset key={group.label}><legend>{group.label}</legend><div>{group.options.map((option, optionIndex) => <button type="button" key={option} data-vault-control="selection" data-control-indicator="bar" aria-pressed={filters[groupIndex] === optionIndex} onClick={() => setFilters((previous) => previous.map((value, index) => index === groupIndex ? optionIndex : value))}>{option}</button>)}</div></fieldset>)}</div>
        <div className={styles.filterFoot}><button type="button" role="switch" aria-checked={hidePoorReviews} data-vault-control="tertiary" onClick={() => setHidePoorReviews(!hidePoorReviews)}><span className={styles.switchTrack} data-checked={hidePoorReviews}><i /></span>Hide poorly reviewed</button><button type="button" data-vault-control="tertiary" disabled={!activeFilters} onClick={() => { setFilters([0, 0, 0, 0]); setHidePoorReviews(false); }}>Reset filters</button></div>
      </section>

      <section className={styles.panel} aria-labelledby="family-title">
        <div className={styles.sectionHeading}><h2 id="family-title"><VaultIcon name="family" size={20} />Family library</h2><span className={styles.count}>113 sample family games</span></div>
        <div className={styles.familyMembers}>{[{ name: "Alex", games: 105, total: 179 }, { name: "Sam", games: 12, total: 27 }].map((member) => <div key={member.name} className={styles.member}><span className={styles.avatar}>{member.name[0]}</span><div><strong>{member.name} <small>(sample)</small></strong><p>{member.games} shareable of {member.total} public games</p></div><VaultIcon name="family" size={20} /></div>)}</div>
        <details className={styles.disclosure}><summary data-vault-control="disclosure">How Family Library works<VaultIcon name="chevron-down" size={16} /></summary><p>Family games expand your pool of choices. This workshop shows sample people and counts; connecting and managing real people happens on your dashboard.</p></details>
      </section>

      <section className={styles.section} aria-labelledby="value-title"><div className={styles.sectionHeading}><h2 id="value-title">Most value for money</h2><span className={styles.muted}>More play, more value</span></div><ol className={styles.gameGrid}>{sampleGames.slice(0, 3).map((game, index) => gameCard(game, index))}</ol></section>

      <section className={styles.section} aria-labelledby="finished-title"><div className={styles.sectionHeading}><h2 id="finished-title">Recently finished</h2><span className={styles.muted}>4 sample completions</span></div><ol className={`${styles.gameGrid} ${styles.finishedGrid}`}>{finishedGames.map((game, index) => gameCard(game, index, true))}</ol></section>

      <section className={styles.palettePanel} aria-labelledby="palette-title"><div className={styles.sectionHeading}><div><h2 id="palette-title">{theme.name} palette</h2><p>The same colour roles, everywhere. A starting point for the global standard.</p></div><button type="button" data-vault-control="secondary" onClick={downloadTheme}>{saved ? "Download again" : "Export theme CSS"}<VaultIcon name="external-link" size={16} /></button></div><div className={styles.swatches}>{paletteRoles.map(([key, label]) => <div key={key}><span style={{ background: theme[key] }} /><strong>{label}</strong><code>{theme[key]}</code></div>)}</div><p className={styles.exportStatus} role="status">{saved ? `${theme.name} CSS downloaded. This is a proposal, ready to review.` : "Semantic actions stay consistent: violet · Steam blue · gold · coral · mint."}</p></section>

      <details className={`${styles.panel} ${styles.audit}`}><summary data-vault-control="disclosure">What the site-wide review found<VaultIcon name="chevron-down" size={18} /></summary><div className={styles.auditGrid}><article><h3>One surface hierarchy</h3><p>Library cards use solid purple; the overview uses its own translucent gradients; information pages mix purple headers and navy wells. Give ground, surface, feature and recess one role each.</p></article><article><h3>Readable secondary text</h3><p>Metadata, captions and controls currently use many unrelated lavender values and opacities. Use one readable muted colour per theme, with size and weight providing hierarchy.</p></article><article><h3>Less competing decoration</h3><p>Multiple glows, panel gradients and luminous borders compete with the game art. Keep emphasis on actions, selected states and the main value summary.</p></article><article><h3>Keep established meaning</h3><p>Reuse the approved stationary controls, original navigation and semantic action colours. Carry the chosen surface tokens through product pages, editorial pages, forms and dialogs.</p></article></div><p className={styles.muted}>Archived proposals. The current website uses dark navy backgrounds and the restored purple panel palette.</p></details>
      <div className={styles.workshopEnd}><p>Built for comparison. Choose a direction, then refine it together.</p><Link href="/dashboard" data-vault-control="text">Open current dashboard<VaultIcon name="chevron-right" size={15} /></Link></div>
    </main>

    <dialog ref={dialogRef} className={styles.dialog} onClose={() => setSelectedGame(null)} onClick={(event) => { if (event.target === event.currentTarget) dialogRef.current?.close(); }} aria-labelledby="game-preview-title">
      {selectedGame ? <><div className={styles.dialogHeading}><span className={styles.muted}>Game detail · workshop preview</span><button type="button" data-vault-control="tertiary" aria-label="Close game preview" onClick={() => dialogRef.current?.close()}><VaultIcon name="close" size={20} /></button></div><div className={styles.dialogArt}><Artwork src={steamHeaderImage(selectedGame.id)} sizes="560px" /></div><h2 id="game-preview-title">{selectedGame.title}</h2><p className={styles.muted}>{selectedGame.genre}</p><div className={styles.dialogStats}><span><strong>{selectedGame.hours}h</strong>Played</span><span><strong>{selectedGame.rate}</strong>Per hour</span><span><strong>{selectedGame.price}</strong>Price</span></div><p className={styles.muted}>Sample data for comparing overlays, surfaces and controls.</p><button type="button" data-vault-control="play-later" onClick={() => { setPinned(selectedGame); dialogRef.current?.close(); }}>Save for later<VaultIcon name="pin" size={17} /></button></> : null}
    </dialog>
  </div>;
}
