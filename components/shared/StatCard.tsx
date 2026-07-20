import styles from "./StatCard.module.css";
import { StatIcon } from "@/components/shared/StatIcon";
import type { BrandedIconName } from "@/components/shared/BrandedIcon";

type StatCardProps = {
  label: string;
  value: number;
  note: string;
  icon: BrandedIconName<"stats">;
  density?: "default" | "compact";
};

export function StatCard({ label, value, note, icon, density = "default" }: StatCardProps) {
  return (
    <article className={`${styles.card} ${styles.cardGlass} ${density === "compact" ? styles.cardCompact : ""}`}>
      <span className={styles.icon}>
        <StatIcon name={icon} size={density === "compact" ? 36 : 42} />
      </span>
      <div className={styles.content}>
        <p className={styles.label}>{label}</p>
        <strong className={styles.value}>{value}</strong>
        <p className={styles.note}>{note}</p>
      </div>
    </article>
  );
}
