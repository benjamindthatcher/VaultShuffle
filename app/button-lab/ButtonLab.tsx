"use client";

import { useEffect, useRef, useState, type ButtonHTMLAttributes } from "react";
import Link from "next/link";
import { VaultIcon, type VaultIconName } from "@/components/shared/VaultIcon";
import current from "../(product)/vault/vault.module.css";
import styles from "./button-lab.module.css";
import { NavigationPreview } from "./NavigationPreview";

const directions = [
  { id: "prism", name: "Prism", tag: "My recommendation", text: "A travelling highlight that settles into pure violet.", detail: "A violet-to-indigo gradient shifts under a soft light sweep, then settles into a solid violet face while hovered. Pressing adds inset depth. The button and its label stay completely still." },
  { id: "lilac", name: "Moonstone", tag: "Maximum contrast", text: "Pale lilac, dark ink. A brighter focal point on your purple panels.", detail: "A luminous lilac face warms towards pearl on hover. Dark lettering stays crisp, with a soft lilac shadow and a tactile press." },
  { id: "edge", name: "Afterglow", tag: "Quiet, then electric", text: "A dark violet face that fills with colour when you reach for it.", detail: "An illuminated violet border frames a dark face. Hover brings in a saturated violet fill, a brighter rim, and a restrained outer glow." },
] as const;

type Direction = typeof directions[number]["id"];
type State = "live" | "hover" | "pressed" | "focus";
type Variant = "primary" | "secondary" | "ghost" | "amber" | "warning" | "danger" | "success";
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  icon?: VaultIconName;
  arrow?: boolean;
  state?: State;
  busy?: boolean;
};

function DemoButton({ variant = "primary", icon, arrow, state = "live", busy, children, className = "", ...props }: ButtonProps) {
  return <button type="button" {...props} aria-busy={busy || undefined} className={`${styles.button} ${className}`} data-variant={variant} data-state={state}>
    <span className={styles.buttonContent}>
      {busy ? <span className={styles.spinner} aria-hidden="true" /> : icon ? <VaultIcon name={icon} size={18} /> : null}
      {children}
      {arrow ? <span className={styles.arrow}><VaultIcon name="chevron-right" size={17} /></span> : null}
    </span>
  </button>;
}

export function ButtonLab() {
  const [direction, setDirection] = useState<Direction>("prism");
  const [state, setState] = useState<State>("live");
  const [surface, setSurface] = useState("purple");
  const [pinned, setPinned] = useState(false);
  const [session, setSession] = useState("Evening");
  const [drawing, setDrawing] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [playingNext, setPlayingNext] = useState(false);
  const [blacklisted, setBlacklisted] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [shortOnly, setShortOnly] = useState(false);
  const [notice, setNotice] = useState("All interactions are local demonstrations.");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selected = directions.find((item) => item.id === direction)!;

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function draw() {
    if (drawing) return;
    setDrawing(true);
    setDrawn(false);
    setNotice("Finding your next game…");
    timer.current = setTimeout(() => {
      setDrawing(false);
      setDrawn(true);
      setNotice("Your preview pick is ready. Try pinning it below.");
    }, 1100);
  }

  return <main className={styles.lab} data-direction={direction} data-vault-controls="standard">
    <header className={styles.header}>
      <Link href="/" className={styles.brand}><span className={styles.brandIcon}><VaultIcon name="shuffle" size={20} /></span>Vault<span>Shuffle</span><span className={styles.headerDivider} /><span className={styles.studioLabel}>Button studio</span></Link>
      <span className={styles.localBadge}><i /> Local concept preview</span>
    </header>

    <div className={styles.content}>
      <section className={styles.intro}>
        <p className={styles.eyebrow}>SMALL DETAILS. BETTER FEEL.</p>
        <h1>A better kind<br className={styles.mobileBreak} /> of <span>click.</span></h1>
        <p>Same VaultShuffle DNA. Light, colour, and depth at every level.<br className={styles.desktopBreak} /> No lift, no bounce. Every button stays exactly where you put it.</p>
      </section>

      <div className={styles.sectionHeading}><h2><span>01</span> Pick a direction</h2><p>Hover the samples. Select one to try the full set.</p></div>
      <section className={styles.directions} aria-label="Button design directions">
        {directions.map((item, index) => <article key={item.id} className={styles.directionCard} data-direction={item.id} data-selected={direction === item.id}>
          <div className={styles.cardHeading}><span className={styles.cardNumber}>0{index + 1}</span><span className={styles.tag}>{item.tag}</span></div>
          <h3>{item.name}</h3>
          <p>{item.text}</p>
          <div className={styles.sample}><DemoButton icon="draw-from-vault" arrow onClick={() => { setDirection(item.id); setNotice(`${item.name} selected for the playground.`); }}>Draw from Vault</DemoButton></div>
          <button type="button" className={styles.choose} aria-pressed={direction === item.id} onClick={() => { setDirection(item.id); setNotice(`${item.name} selected for the playground.`); }}><span>{direction === item.id ? "Selected direction" : `Explore ${item.name}`}</span><VaultIcon name={direction === item.id ? "check" : "chevron-right"} size={17} /></button>
        </article>)}
      </section>

      <section className={styles.playground} aria-labelledby="playground-title">
        <div className={styles.sectionHeading}><h2 id="playground-title"><span>02</span> Feel it in context</h2><span className={styles.activeName}>{selected.name} collection</span></div>
        <div className={styles.toolbar}>
          <div className={styles.controlGroup}><span>Preview state</span><div className={styles.segmented} aria-label="Preview state">{(["live", "hover", "pressed", "focus"] as const).map((value) => <button key={value} type="button" aria-pressed={state === value} onClick={() => setState(value)}>{value === "live" ? "Interactive" : value === "focus" ? "Focus" : value === "pressed" ? "Pressed" : "Hover"}</button>)}</div></div>
          <div className={styles.controlGroup}><span>Surface</span><div className={styles.segmented} aria-label="Preview background"><button type="button" aria-pressed={surface === "purple"} onClick={() => setSurface("purple")}>Purple</button><button type="button" aria-pressed={surface === "ink"} onClick={() => setSurface("ink")}>Ink</button></div></div>
        </div>
        <div className={styles.contextGrid} data-surface={surface}>
          <div className={styles.vaultScene}>
            <div className={styles.sceneArt} aria-hidden="true" />
            <div className={styles.sceneCopy}>
              <p className={styles.eyebrow}>YOUR NEXT GREAT GAME</p>
              <h3>{drawn ? "Your next adventure awaits." : "Less scrolling. More playing."}</h3>
              <p>{drawn ? "A fresh pick, matched to your evening." : "Set the moment. Let the Vault find the match."}</p>
              <div className={styles.chips} role="group" aria-label="Session length">{["Short", "Evening", "Weekend"].map((value) => <button className={styles.chip} data-state={state} key={value} type="button" aria-pressed={session === value} onClick={() => setSession(value)}><VaultIcon name={session === value ? "check" : "clock"} size={14} />{value}</button>)}</div>
              <div className={styles.sceneActions}>
                <DemoButton state={state} icon={drawn ? "check" : "shuffle"} arrow={!drawing} busy={drawing} disabled={drawing} onClick={draw}>{drawing ? "Finding your game…" : drawn ? "Draw again" : "Draw from Vault"}</DemoButton>
                <DemoButton state={state} variant="ghost" onClick={() => setNotice("The library would open here. This preview stays on this page.")}>Browse library <VaultIcon name="chevron-right" size={16} /></DemoButton>
              </div>
            </div>
          </div>
          <div className={styles.actionPanel}>
            <p className={styles.eyebrow}>THE EVERYDAY ACTIONS</p>
            <h3>A place for every action.</h3>
            <p>One clear lead. Supporting actions stay quieter. Colour carries meaning.</p>
            <div className={styles.actionStack}>
              <DemoButton state={state} icon="open-steam" arrow onClick={() => setNotice("Steam launch preview — no external app opened.")}>Open on Steam</DemoButton>
              <div className={styles.actionPair}>
                <DemoButton state={state} variant={pinned ? "success" : "amber"} icon={pinned ? "check" : "pin"} aria-pressed={pinned} onClick={() => { setPinned(!pinned); setNotice(pinned ? "Preview pick unpinned." : "Preview pick pinned. Click again to undo."); }}>{pinned ? "Pinned" : "Pin this pick"}</DemoButton>
                <DemoButton state={state} variant="secondary" icon="snooze" onClick={() => setNotice("Snooze preview — your library has not changed.")}>Snooze</DemoButton>
              </div>
              <div className={styles.actionPair}>
                <DemoButton state={state} variant="secondary" icon="add" onClick={() => setNotice("Collection action preview — your library has not changed.")}>Collection</DemoButton>
                <DemoButton state={state} variant="ghost" icon="details" onClick={() => setNotice("Details preview — quiet actions brighten without an outer glow.")}>Details</DemoButton>
              </div>
            </div>
            <div className={styles.panelFoot}><VaultIcon name="check" size={15} /><span>Try pinning, drawing, and changing the session.</span></div>
          </div>
        </div>
        <div className={styles.librarySample} data-surface={surface}>
          <div className={styles.libraryHeading}><div><p className={styles.eyebrow}>INSIDE THE APP</p><h3>Library & collection controls</h3></div><span>Compact actions, same family</span></div>
          <div className={styles.libraryToolbar}>
            <DemoButton state={state} variant="secondary" icon="filter" aria-expanded={filtersOpen} aria-controls="preview-filters" onClick={() => setFiltersOpen(!filtersOpen)}>Filters{shortOnly ? " · 1" : ""}<VaultIcon name="chevron-down" size={15} /></DemoButton>
            <DemoButton state={state} variant="ghost" icon="sort" onClick={() => setNotice("Sort control preview — the sample row stays in place.")}>Playtime<VaultIcon name="chevron-down" size={15} /></DemoButton>
            <div className={styles.libraryUtilities}><DemoButton state={state} variant="secondary" icon="chevron-left" aria-label="Previous collection" className={styles.iconButton} onClick={() => setNotice("Previous collection preview.")} /><DemoButton state={state} variant="secondary" icon="chevron-right" aria-label="Next collection" className={styles.iconButton} onClick={() => setNotice("Next collection preview.")} /><DemoButton state={state} icon="new-collection" onClick={() => setNotice("New collection preview — no collection is created.")}>New collection</DemoButton></div>
          </div>
          {filtersOpen ? <div id="preview-filters" className={styles.filterTray}><span>Game length</span><button className={styles.chip} data-state={state} type="button" aria-pressed={!shortOnly} onClick={() => setShortOnly(false)}><VaultIcon name={!shortOnly ? "check" : "clock"} size={14} />Any length</button><button className={styles.chip} data-state={state} type="button" aria-pressed={shortOnly} onClick={() => setShortOnly(true)}><VaultIcon name={shortOnly ? "check" : "clock"} size={14} />Under 10h</button><span>Sample filter · no library changes</span></div> : null}
          <div className={styles.libraryRow}>
            <span className={styles.gameMark}><VaultIcon name="all-games" size={24} /></span>
            <div className={styles.gameTitle}><strong>Portal 2</strong><span>{blacklisted ? "Blacklisted" : completed ? "Completed" : playingNext ? "Playing next" : "In progress"} · Preview game</span></div>
            <div className={styles.libraryActions}>
              <DemoButton state={state} variant="warning" icon={blacklisted ? "undo" : "paused"} aria-pressed={blacklisted} onClick={() => { setBlacklisted(!blacklisted); setNotice(blacklisted ? "Preview game restored." : "Preview game blacklisted. Click Restore to undo."); }}>{blacklisted ? "Restore" : "Blacklist"}</DemoButton>
              <DemoButton state={state} variant="success" icon={completed ? "check" : "mark-completed"} aria-pressed={completed} onClick={() => { setCompleted(!completed); setNotice(completed ? "Completion undone for the sample game." : "Sample game completed. Click again to undo."); }}>{completed ? "Completed" : "Complete"}</DemoButton>
              <DemoButton state={state} variant="secondary" icon={playingNext ? "check" : "play-now"} aria-pressed={playingNext} onClick={() => { setPlayingNext(!playingNext); setNotice(playingNext ? "Sample game removed from Playing Next." : "Sample game added to Playing Next."); }}>Playing Next</DemoButton>
            </div>
          </div>
        </div>
        <div className={styles.liveNote} role="status"><span className={styles.statusDot} />{notice}</div>
      </section>

      <section className={styles.states} aria-labelledby="states-title">
        <div className={styles.sectionHeading}><h2 id="states-title"><span>03</span> The details make it</h2><p>Every state, side by side.</p></div>
        <div className={styles.tierEffects}>
          {([
            { variant: "primary", name: "Primary · light sweep", copy: "Moving light and a richer gradient. Press for a deeper, inset face.", label: "Draw a game", icon: "shuffle" },
            { variant: "secondary", name: "Secondary · satin sheen", copy: "A lavender sheen crosses left to right, leaving a richer violet face and luminous rim. Press for inset depth; the button stays still.", label: "Create profile", icon: "id" },
            { variant: "ghost", name: "Tertiary · light underline", copy: "Text brightens, a soft tint appears, and a fine line opens from the centre. Press for a brighter, tighter line.", label: "View details", icon: "details" },
          ] as const).map((tier) => <div className={styles.tierRow} key={tier.variant}>
            <div className={styles.tierCopy}><h3>{tier.name}</h3><p>{tier.copy}</p></div>
            <div className={styles.tierSamples}>{(["live", "hover", "pressed"] as const).map((value) => <div key={value}><span className={styles.stateLabel}>{value === "live" ? "Try it" : value}</span><DemoButton variant={tier.variant} state={value} icon={tier.icon} onClick={() => setNotice(`${tier.name} — colour and light change; the button stays still.`)}>{tier.label}</DemoButton></div>)}</div>
          </div>)}
          <div className={styles.tierRow}>
            <div className={styles.tierCopy}><h3>Selection · stays chosen</h3><p>Session, mood, and filter choices set a value. Hover softly lights the face; press adds inset depth. A violet fill and checkmark stay on the chosen option.</p></div>
            <div className={`${styles.tierSamples} ${styles.selectionSamples}`}>{(["live", "hover", "pressed", "selected"] as const).map((value) => <div key={value}><span className={styles.stateLabel}>{value === "live" ? "Default" : value}</span><button type="button" className={styles.chip} data-state={value === "selected" ? "live" : value} aria-pressed={value === "selected"} onClick={() => setNotice("Selection sample — try Short, Evening, and Weekend above to change the chosen value.")}><VaultIcon name={value === "selected" ? "check" : "clock"} size={14} />Evening</button></div>)}</div>
          </div>
        </div>
        <div className={styles.stateGrid}>
          {(["live", "hover", "pressed", "focus"] as const).map((value) => <div key={value}><span className={styles.stateLabel}>{value === "live" ? "Default" : value === "focus" ? "Keyboard focus" : value}</span><DemoButton state={value} icon="shuffle" onClick={() => setNotice(`This is the ${value === "live" ? "default" : value} appearance.`)}>Draw a game</DemoButton></div>)}
          <div><span className={styles.stateLabel}>Loading</span><DemoButton busy disabled>Finding a game</DemoButton></div>
          <div><span className={styles.stateLabel}>Disabled</span><DemoButton disabled icon="lock">Choose a session</DemoButton></div>
        </div>
      </section>

      <section className={styles.surfaceStandards} aria-labelledby="surface-standards-title">
        <div className={styles.sectionHeading}><h2 id="surface-standards-title">Approved buttons &amp; image panes</h2><p>Shared site styles · stationary artwork, labels and icons.</p></div>
        <div className={styles.standardActions}>
          <button type="button" data-vault-control="secondary" onClick={() => setNotice("Roll the dice uses the standard secondary treatment.")}><VaultIcon name="shuffle" size={18} />Roll the dice</button>
          <button type="button" data-vault-control="primary" onClick={() => setNotice("Preview banners use the standard primary Create profile button.")}><VaultIcon name="id" size={18} />Create profile</button>
        </div>
        <div className={styles.surfaceSamples}>
          <button type="button" data-vault-card="interactive" className={styles.surfaceSample} onClick={() => setNotice("Interactive card: sheen, lavender edge, inset press. No movement.")}>
            <span className={styles.surfaceArtwork} aria-hidden="true" /><strong>Interactive game card</strong><span>Hover, focus and press</span>
          </button>
          <article data-vault-card="surface" className={styles.surfaceSample}>
            <span className={styles.surfaceArtwork} aria-hidden="true" /><strong>Collection image pane</strong><span>Same hover · informational surface</span>
          </article>
        </div>
      </section>

      <NavigationPreview />

      <section className={styles.comparison} aria-labelledby="comparison-title">
        <div className={styles.comparisonCopy}><p className={styles.eyebrow}>THE DIFFERENCE</p><h2 id="comparison-title">Light moves.<br />Buttons stay put.</h2><p>{selected.detail}</p><p>Secondary buttons illuminate from within. Tertiary actions reveal a fine underline. Pin keeps its warm amber identity, and destructive actions stay rose. Every tier responds to hover and press.</p></div>
        <div className={styles.compareSamples}>
          <div className={styles.compareRow}><span>Current Vault button<small>Original colours · movement disabled here</small></span><button className={current.ctaButton} type="button" onClick={() => setNotice("Current button — original colours, with movement disabled in this preview.")}><VaultIcon name="shuffle" size={18} />Draw a game</button></div>
          <div className={styles.compareRow}><span>{selected.name}<small>Hover, then press and hold</small></span><DemoButton icon="shuffle" arrow onClick={() => setNotice(`${selected.name} — release returns the button to its resting state.`)}>Draw a game</DemoButton></div>
          <div className={styles.compareRow}><span>Destructive action<small>Rose feedback, no purple wash</small></span><DemoButton variant="danger" icon="close" onClick={() => setNotice("Remove preview only — nothing has been removed.")}>Remove game</DemoButton></div>
        </div>
      </section>
      <footer className={styles.notes}><span><VaultIcon name="check" size={16} /> Keyboard focus</span><span><VaultIcon name="check" size={16} /> Reduced-motion support</span><span><VaultIcon name="check" size={16} /> Touch-friendly controls</span><span>Preview only · No site-wide changes</span></footer>
    </div>
  </main>;
}
