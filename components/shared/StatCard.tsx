import type { ReactNode } from "react";
import styles from "./StatCard.module.css";
import { VaultIcon, type VaultIconName } from "@/components/shared/VaultIcon";

type StatPanelProps = {
  label: string;
  children: ReactNode;
};

/* The panel the stat tiles sit in. Library and Collections both render this so
   their top sections stay the same shape as each other, and as the setup panels
   Vault and Purge open with. */
export function StatPanel({ label, children }: StatPanelProps) {
  return (
    <section className={styles.panel} aria-label={label}>
      <div className={styles.grid}>{children}</div>
    </section>
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
