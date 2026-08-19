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
    <div className={styles.grid} role="group" aria-label={label} style={style}>
      {children}
    </div>
  );
}

type StatCardProps = {
  label: string;
  value: number;
  note: string;
  icon?: VaultIconName;
  actionIcon?: VaultIconName;
};

export function StatCard({ label, value, note, icon, actionIcon }: StatCardProps) {
  return (
    <article className={styles.card}>
      <span className={styles.icon}>
        {actionIcon || icon ? <VaultIcon name={(actionIcon ?? icon)!} size={36} /> : null}
      </span>
      <div className={styles.content}>
        <p className={styles.label}>{label}</p>
        <strong className={styles.value}>{value}</strong>
        <p className={styles.note}>{note}</p>
      </div>
    </article>
  );
}
