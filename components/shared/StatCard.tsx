import styles from "./StatCard.module.css";
import { VaultIcon, type VaultIconName } from "@/components/shared/VaultIcon";

type StatCardProps = {
  label: string;
  value: number;
  note: string;
  icon?: VaultIconName;
  actionIcon?: VaultIconName;
  density?: "default" | "compact";
};

export function StatCard({ label, value, note, icon, actionIcon, density = "default" }: StatCardProps) {
  return (
    <article className={`${styles.card} ${styles.cardGlass} ${density === "compact" ? styles.cardCompact : ""}`}>
      <span className={styles.icon}>
        {actionIcon || icon ? <VaultIcon name={(actionIcon ?? icon)!} size={density === "compact" ? 36 : 42} /> : null}
      </span>
      <div className={styles.content}>
        <p className={styles.label}>{label}</p>
        <strong className={styles.value}>{value}</strong>
        <p className={styles.note}>{note}</p>
      </div>
    </article>
  );
}
