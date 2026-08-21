import type { ReactNode } from "react";
import styles from "./PlaceholderSlots.module.css";

type PlaceholderSlotsProps = {
  /** How many dashed slots to draw. Enough to show the grid's shape. */
  count?: number;
  /** Said once, in the first slot. The rest are decoration. */
  label: ReactNode;
  /** A way out of the empty state, shown under the label. */
  action?: ReactNode;
  size?: "card" | "wide" | "row";
};

export function PlaceholderSlots({ count = 4, label, action, size = "card" }: PlaceholderSlotsProps) {
  const sizeClass = size === "wide" ? styles.slotWide : size === "row" ? styles.slotRow : styles.slotCard;

  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className={`${styles.slot} ${sizeClass}`}
          aria-hidden={index > 0 || undefined}
        >
          {index === 0 ? (
            <div>
              <p className={styles.label}>{label}</p>
              {action}
            </div>
          ) : null}
        </div>
      ))}
    </>
  );
}
