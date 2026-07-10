import styles from "./StatCard.module.css";
import { StatIcon } from "@/components/shared/StatIcon";

type StatCardProps = {
  label: string;
  value: number;
  note: string;
};

export function StatCard({ label, value, note }: StatCardProps) {
  return (
    <article className={styles.card}>
      <span className={styles.icon}><StatIcon label={label} /></span>
      <div className={styles.content}>
        <p className={styles.label}>{label}</p>
        <strong className={styles.value}>{value}</strong>
        <p className={styles.note}>{note}</p>
      </div>
    </article>
  );
}
