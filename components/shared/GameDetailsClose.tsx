import type { Ref } from "react";
import { VaultIcon } from "./VaultIcon";
import styles from "@/components/library/LibraryDetailsDrawer.module.css";

/** Keep dismissal reachable even when a short screen scrolls past the artwork. */
export function GameDetailsClose({ buttonRef, onClose }: { buttonRef: Ref<HTMLButtonElement>; onClose: () => void }) {
  return <div className={styles.closeAnchor}>
    <button ref={buttonRef} type="button" data-vault-control="secondary" data-control-position="floating" className={styles.previewClose} onClick={onClose} aria-label="Close game details">
      <VaultIcon name="close" size={20} />
      <span>Close</span>
    </button>
  </div>;
}
