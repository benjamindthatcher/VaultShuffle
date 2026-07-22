import styles from "./StatCard.module.css";
import { StatIcon } from "@/components/shared/StatIcon";
import { BrandedIcon } from "@/components/shared/BrandedIcon";
import type { BrandedIconName } from "@/components/shared/BrandedIcon";

type StatCardProps = {
  label: string;
  value: number;
  note: string;
  icon?: BrandedIconName<"stats">;
  actionIcon?: BrandedIconName<"actions">;
  density?: "default" | "compact";
};

export function StatCard({ label, value, note, icon, actionIcon, density = "default" }: StatCardProps) {
  return (
    <article className={`${styles.card} ${styles.cardGlass} ${density === "compact" ? styles.cardCompact : ""}`}>
      <span className={styles.icon}>
        {actionIcon ? <BrandedIcon group="actions" name={actionIcon} size={density === "compact" ? 36 : 42} /> : icon ? <StatIcon name={icon} size={density === "compact" ? 36 : 42} /> : null}
      </span>
      <div className={styles.content}>
        <p className={styles.label}>{label}</p>
        <strong className={styles.value}>{value}</strong>
        <p className={styles.note}>{note}</p>
      </div>
    </article>
  );
}
