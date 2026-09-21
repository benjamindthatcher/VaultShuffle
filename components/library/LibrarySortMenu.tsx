"use client";

import { useEffect, useId, useRef, useState } from "react";
import { VaultIcon } from "@/components/shared/VaultIcon";
import styles from "./LibraryToolbar.module.css";

const OPTIONS = [
  ["recent", "Recently played"], ["title", "Title"], ["hours", "Playtime"],
  ["progress", "Progress"], ["added", "Date added"], ["duration", "Estimated length"], ["status", "Status"],
] as const;

export function LibrarySortMenu({ value, onChange, showDuration }: { value: string; onChange: (value: string) => void; showDuration: boolean }) {
  const options = OPTIONS.filter(([id]) => id !== "duration" || showDuration);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", time: 0 });
  const id = useId();
  const selected = Math.max(0, options.findIndex(([key]) => key === value));
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    list.current?.focus({ preventScroll: true });
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  function choose(index: number) {
    onChange(options[index][0]);
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }
  return <div className={styles.sortMenu} ref={root} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} type="button" className={styles.sortTrigger} id="library-sort" aria-label={`Sort: ${options[selected][1]}`} aria-haspopup="listbox" aria-controls={open ? id : undefined} aria-expanded={open}
      onClick={() => { setFocused(selected); setOpen(!open); }}
      onKeyDown={(event) => { if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); setFocused(event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : selected); setOpen(true); } }}>
      <span>{options[selected][1]}</span><VaultIcon name="chevron-down" size={16} />
    </button>
    {open ? <div ref={list} id={id} role="listbox" aria-label="Sort games" className={styles.sortOptions} tabIndex={-1} aria-activedescendant={`${id}-${focused}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus({ preventScroll: true }); }
        else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(focused); }
        else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault(); setFocused(event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (focused + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const now = event.timeStamp; typed.current = { text: (now - typed.current.time < 600 ? typed.current.text : "") + event.key.toLowerCase(), time: now };
          const match = options.findIndex(([, label]) => label.toLowerCase().startsWith(typed.current.text));
          if (match >= 0) setFocused(match);
        }
      }}>
      {options.map(([key, label], index) => <div key={key} id={`${id}-${index}`} role="option" aria-selected={key === value} data-focused={focused === index || undefined} className={styles.sortOption} onPointerMove={() => setFocused(index)} onClick={() => choose(index)}>
        <span className={styles.sortCheck}>{key === value ? <VaultIcon name="check" size={17} /> : null}</span><span>{label}</span>
      </div>)}
    </div> : null}
  </div>;
}
