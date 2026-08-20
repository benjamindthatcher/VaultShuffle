import type { CSSProperties, ReactNode } from "react";
import styles from "./StatCard.module.css";
import { VaultIcon, type VaultIconName } from "@/components/shared/VaultIcon";

type StatPanelProps = {
  label: string;
  columns: number;
  children: ReactNode;
};

/* The stat row. A plain grid on the page ground: the cards are the only
   surface, so there is no box around the box. Library and Collections both
   render this, so their opening row stays identical. */
export function StatPanel({ label, columns, children }: StatPanelProps) {
  const style = {
    "--stat-columns": columns,
    "--stat-columns-tablet": columns > 4 ? 3 : 2
  } as CSSProperties;

  return (
    <section className={styles.panel} aria-label={label} style={style}>
      <div className={styles.grid}>{children}</div>
    </section>
  );
}

type StatCardProps = {
  label: string;
  /** Short enough to stay on one line: a count, a percentage, a rate. */
  value: ReactNode;
  note: ReactNode;
  icon?: VaultIconName;
  actionIcon?: VaultIconName;
};

export function StatCard({ label, value, note, icon, actionIcon }: StatCardProps) {
  const glyph = actionIcon ?? icon;

  return (
    <article className={styles.card} data-icon={glyph ? undefined : "none"}>
      {glyph ? <span className={styles.icon}><VaultIcon name={glyph} size={36} /></span> : null}
      <div className={styles.content}>
        <p className={styles.label}>{label}</p>
        <strong className={styles.value}>{value}</strong>
        <p className={styles.note}>{note}</p>
      </div>
    </article>
  );
}
