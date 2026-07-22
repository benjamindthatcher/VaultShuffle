"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Artwork } from "@/components/shared/Artwork";
import { ScrollControls } from "@/components/shared/ScrollControls";
import type { DemoCollection, DemoGame } from "@/lib/demo-data";
import type { VaultDraw } from "@/lib/vault-history";
import { steamStoreUrl } from "@/lib/steam-images";
import styles from "./VaultHistoryDrawer.module.css";

type Props = { open: boolean; draws: VaultDraw[]; games: DemoGame[]; collections: DemoCollection[]; onClose: () => void; onClear: () => Promise<void>; onUseSetup: (draw: VaultDraw, drawNow: boolean) => void; onPin: (game: DemoGame) => void; onEvent: (drawId: string, type: "opened_on_steam" | "pinned") => void };

export function VaultHistoryDrawer({ open, draws, games, collections, onClose, onClear, onUseSetup, onPin, onEvent }: Props) {
  const [mounted, setMounted] = useState(false); const [selected, setSelected] = useState<VaultDraw | null>(null); const panelRef = useRef<HTMLElement>(null);
  useEffect(() => setMounted(true), []);
  useEffect(() => { if (!open) { setSelected(null); return; } const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null; const overflow = document.body.style.overflow; document.body.style.overflow = "hidden"; requestAnimationFrame(() => panelRef.current?.focus()); const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); if (event.key === "Tab" && panelRef.current) { const focusable = [...panelRef.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),select,input,[tabindex]:not([tabindex="-1"])')]; if (!focusable.length) { event.preventDefault(); return; } const first = focusable[0], last = focusable.at(-1)!; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } } }; document.addEventListener("keydown", key); return () => { document.removeEventListener("keydown", key); document.body.style.overflow = overflow; previous?.focus(); }; }, [onClose, open]);
  if (!mounted || !open) return null;
  const game = selected ? games.find((item) => item.steamAppId === selected.steamAppId) ?? null : null;
  return createPortal(<div className={styles.layer}><button className={styles.backdrop} type="button" aria-label="Close history" onClick={onClose} /><aside ref={panelRef} className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby="history-title" tabIndex={-1}><ScrollControls targetRef={panelRef} axis="vertical" label="Scroll draw history" />
    <header><div><p>Vault Deck</p><h2 id="history-title">Draw History</h2></div><button type="button" aria-label="Close history" onClick={onClose}>×</button></header>
    {selected && game ? <div className={styles.detail}>
      <button type="button" className={styles.back} onClick={() => setSelected(null)}>← Back to history</button><div className={styles.detailArtwork}><Artwork src={game.bannerUrl} sizes="420px" /></div><h3>{game.title}</h3><p>{setupLabel(selected)}</p>
      {!collections.some((collection) => collection.id === selected.collectionId) && selected.collectionId ? <p className={styles.notice}>That collection no longer exists. Reusing this setup will use Entire Vault.</p> : null}
      <div className={styles.detailActions}><a href={steamStoreUrl(game.steamAppId)} target="_blank" rel="noreferrer" onClick={() => onEvent(selected.id, "opened_on_steam")}>Open on Steam</a><button type="button" onClick={() => { onPin(game); onEvent(selected.id, "pinned"); }}>Pin</button><button type="button" onClick={() => onUseSetup(selected, false)}>Use This Setup</button><button type="button" onClick={() => onUseSetup(selected, true)}>Draw Again With This Setup</button></div>
    </div> : draws.length ? <><div className={styles.list}>{groupDraws(draws).map(([label, entries]) => <section key={label}><h3>{label}</h3>{entries.map((draw) => { const entryGame = games.find((item) => item.steamAppId === draw.steamAppId); return <button type="button" className={styles.entry} key={draw.id} onClick={() => setSelected(draw)}>{entryGame ? <span className={styles.thumb}><Artwork src={entryGame.bannerUrl} sizes="76px" /></span> : null}<span><strong>{entryGame?.title ?? `Steam App ${draw.steamAppId}`}</strong><small>{setupLabel(draw)}</small><em>{eventLabel(draw.events[0]?.eventType)}</em></span><time dateTime={draw.drawnAt}>{new Date(draw.drawnAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></button>; })}</section>)}</div><button type="button" className={styles.clear} onClick={() => void onClear()}>Clear draw history</button></> : <div className={styles.empty}><h3>No draws yet</h3><p>Games you draw from the Vault will appear here.</p><button type="button" onClick={onClose}>Draw from the Vault</button></div>}
  </aside></div>, document.body);
}
function setupLabel(draw: VaultDraw) { const labels = { short: "Short", evening: "Evening", weekend: "Weekend", "brain-off": "Brain-Off", chill: "Chill", intense: "Intense", new: "Something New", finish: "Finish Something", surprise: "Surprise Me" }; return `${labels[draw.session]} · ${labels[draw.mood]} · ${labels[draw.goal]}`; }
function eventLabel(type?: string) { if (!type) return "Drawn"; return type.split("_").map((word) => word[0].toUpperCase() + word.slice(1)).join(" "); }
function groupDraws(draws: VaultDraw[]) { const groups = new Map<string, VaultDraw[]>(); for (const draw of draws) { const date = new Date(draw.drawnAt); const now = new Date(); const label = date.toDateString() === now.toDateString() ? "Today" : date.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" }); groups.set(label, [...(groups.get(label) ?? []), draw]); } return [...groups.entries()]; }
