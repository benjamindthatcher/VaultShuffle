"use client";

import { useEffect, useId, useRef, useState } from "react";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { STEAM_PRICE_MARKETS, steamPriceMarket, steamPriceMarketSearch } from "@/lib/steam-store-regions";
import styles from "./Wishlist.module.css";

/** The Library's anchored listbox, with search for Steam's pricing markets. */
export function WishlistRegionMenu({ value, onChange }: { value: string; onChange: (country: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", time: 0 });
  const id = useId();
  const selected = steamPriceMarket(value);
  const regions = STEAM_PRICE_MARKETS.filter(region => steamPriceMarketSearch(region).includes(query.trim().toLowerCase()));

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    search.current?.focus({ preventScroll: true });
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  useEffect(() => {
    if (!open || !list.current) return;
    const container = list.current;
    const option = container.children[focused] as HTMLElement | undefined;
    if (!option) return;
    // Scroll only the menu, never the page containing the recommendations.
    const top = option.offsetTop;
    if (top < container.scrollTop) container.scrollTop = top;
    else if (top + option.offsetHeight > container.scrollTop + container.clientHeight) {
      container.scrollTop = top + option.offsetHeight - container.clientHeight;
    }
  }, [open, focused, query]);

  function show(index = Math.max(0, STEAM_PRICE_MARKETS.findIndex(region => region.code === selected.code))) {
    setQuery(""); setFocused(index); setOpen(true);
  }
  function close() {
    setOpen(false); trigger.current?.focus({ preventScroll: true });
  }
  function choose(index: number) {
    const region = regions[index];
    if (!region) return;
    if (region.code !== value) onChange(region.code);
    close();
  }

  return <div className={styles.region} ref={root} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <span id={`${id}-label`}>Store region</span>
    <div className={styles.regionMenu}>
      <button ref={trigger} type="button" className={styles.regionTrigger} data-vault-control="secondary"
        aria-label={`Steam store region: ${selected.name}`} title={selected.name} aria-haspopup="listbox"
        aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => open ? setOpen(false) : show()}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            show(event.key === "Home" ? 0 : event.key === "End" ? STEAM_PRICE_MARKETS.length - 1 : undefined);
          }
        }}>
        <span>{selected.name}</span><VaultIcon name="chevron-down" size={15} />
      </button>
      {open ? <div className={styles.regionPopover}>
        <input ref={search} type="search" className={styles.regionSearch} aria-label="Search store regions"
          placeholder="Find a region or currency…" value={query} aria-controls={id}
          onChange={(event) => { setQuery(event.target.value); setFocused(0); }}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); close(); }
            else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault(); list.current?.focus({ preventScroll: true });
            } else if (event.key === "Enter") { event.preventDefault(); choose(focused); }
          }} />
        <div ref={list} id={id} role="listbox" aria-labelledby={`${id}-label`} className={styles.regionOptions}
          tabIndex={-1} aria-activedescendant={regions.length ? `${id}-${regions[focused]?.code}` : undefined}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); close(); }
            else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(focused); }
            else if (regions.length && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              setFocused(event.key === "Home" ? 0 : event.key === "End" ? regions.length - 1 : (focused + (event.key === "ArrowDown" ? 1 : -1) + regions.length) % regions.length);
            } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
              typed.current = { text: (event.timeStamp - typed.current.time < 600 ? typed.current.text : "") + event.key.toLowerCase(), time: event.timeStamp };
              const match = regions.findIndex(region => region.name.toLowerCase().startsWith(typed.current.text));
              if (match >= 0) setFocused(match);
            }
          }}>
          {regions.map(({ code, name, currency }, index) => <div key={code} id={`${id}-${code}`}
            role="option" aria-label={name} aria-selected={code === selected.code} data-focused={focused === index || undefined}
            data-vault-control="selection" data-control-indicator="bar" className={styles.regionOption}
            onPointerMove={() => setFocused(index)} onClick={() => choose(index)}><span>{name}</span><small>{currency}</small></div>)}
        </div>
        {!regions.length ? <p className={styles.regionEmpty} role="status">No regions found.</p> : null}
      </div> : null}
    </div>
  </div>;
}
