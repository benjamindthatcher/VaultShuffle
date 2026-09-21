import type { DemoGame } from "@/lib/demo-data";
import styles from "./LibraryGameActions.module.css";

type Props = {
  status: DemoGame["status"];
  pinned?: boolean;
  onBlacklist?: () => void;
  onComplete?: () => void;
  onRestore?: () => void;
  onPlayingNext?: () => void;
};

/** Shared by the catalogue and details: the order and meaning never change. */
export function LibraryGameActions({ status, pinned, onBlacklist, onComplete, onRestore, onPlayingNext }: Props) {
  const active = status !== "Slept" && status !== "Completed";
  return <div className={styles.actions} role="group" aria-label="Game actions">
    {!active && onRestore ? <button type="button" className={styles.restore} onClick={onRestore}><ActionIcon kind="restore" /><span>Reactivate</span></button> : null}
    {status !== "Slept" && onBlacklist ? <button type="button" className={styles.blacklist} onClick={onBlacklist}><ActionIcon kind="blacklist" /><span>Blacklist</span></button> : null}
    {status !== "Completed" && onComplete ? <button type="button" className={styles.complete} onClick={onComplete}><ActionIcon kind="complete" /><span>Complete</span></button> : null}
    {active && onPlayingNext ? <button type="button" className={styles.next} onClick={onPlayingNext}><ActionIcon kind="next" /><span>{pinned ? "Remove from Playing Next" : "Playing Next"}</span></button> : null}
  </div>;
}

export function ActionIcon({ kind }: { kind: "blacklist" | "complete" | "next" | "restore" }) {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "blacklist" ? <><rect x="4" y="4" width="16" height="16" rx="5" /><path d="M8 12h8" /></> : null}
    {kind === "complete" ? <><path d="m12 2 3 2 3.5.5.5 3.5 2 4-2 3-.5 3.5-3.5.5-3 2-3-2-3.5-.5L5 15l-2-3 2-4 .5-3.5L9 4z" /><path d="m8 12 2.5 2.5L16 9" /></> : null}
    {kind === "next" ? <><path d="M5 5.5v13l9-6.5zM18 6v12" /></> : null}
    {kind === "restore" ? <><path d="M4 10a8 8 0 1 1 1 7M4 4v6h6" /></> : null}
  </svg>;
}
