import { useId } from "react";
import styles from "./ValueDial.module.css";

const RADIUS = 62;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const TICKS = 48;
// Decorative ledger silhouette, not a historical data series.
const BARS = [8, 14, 13, 10, 17, 12, 24, 29, 34, 25, 36, 23, 38, 50, 32, 52, 37, 54, 64, 55, 43];

type ValueDialProps = {
  percent: number | null;
  completedValue: string;
  libraryValue: string;
};

export function ValueDial({ percent, completedValue, libraryValue }: ValueDialProps) {
  const gradientId = useId();
  const clamped = Math.max(0, Math.min(100, percent ?? 0));
  const offset = CIRCUMFERENCE * (1 - clamped / 100);
  const litTicks = Math.round(clamped / 100 * TICKS);

  return (
    <div className={styles.dial} role="group" aria-label={percent === null ? "Library value unavailable" : `${completedValue} of ${libraryValue} finished, ${clamped}% of your library's value`}>
      <div className={styles.copy}>
        <p className={styles.label}>Library value completed</p>
        <p className={styles.value}>{completedValue}</p>
        <p className={styles.total}>of <strong>{libraryValue}</strong> library value</p>
        <div className={styles.bars} aria-hidden="true">
          {BARS.map((height, index) => <span key={index} style={{ height: `${height}%` }} />)}
        </div>
      </div>
      <div className={styles.ringWrap}>
        <svg className={styles.ring} viewBox="0 0 160 160" aria-hidden="true">
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--vault-accent)" />
              <stop offset="100%" stopColor="var(--vault-brand-violet)" />
            </linearGradient>
            <linearGradient id={`${gradientId}-bezel`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--vault-accent)" stopOpacity=".75" />
              <stop offset="38%" stopColor="var(--vault-border-strong)" />
              <stop offset="68%" stopColor="var(--vault-well-surface)" />
              <stop offset="100%" stopColor="var(--vault-brand-violet)" stopOpacity=".65" />
            </linearGradient>
          </defs>
          <circle cx="80" cy="80" r="78" fill="none" stroke={`url(#${gradientId}-bezel)`} strokeWidth="1" />
          <circle className={styles.bezelInner} cx="80" cy="80" r="74" fill="none" strokeWidth="1" />
          <circle className={styles.ringBody} cx="80" cy="80" r="59" fill="none" strokeWidth="25" />
          <circle cx="80" cy="80" r="71" fill="none" stroke={`url(#${gradientId}-bezel)`} strokeWidth="1.5" />
          <circle className={styles.ringTrack} cx="80" cy="80" r={RADIUS} fill="none" strokeWidth="9" />
          <circle className={styles.innerLip} cx="80" cy="80" r="43" fill="none" strokeWidth="1" />
          {Array.from({ length: TICKS }, (_, index) => (
            <line key={index} className={index < litTicks ? styles.tickLive : styles.tick}
              x1={index % 4 === 0 ? 124 : 127} y1="80" x2="131" y2="80"
              transform={`rotate(${index * 360 / TICKS} 80 80)`} strokeWidth="1" />
          ))}
          <circle className={styles.ringFill} cx="80" cy="80" r={RADIUS} fill="none" strokeWidth="9"
            stroke={`url(#${gradientId})`} strokeDasharray={CIRCUMFERENCE} strokeDashoffset={offset}
            style={{ opacity: clamped === 0 ? 0 : 1 }} />
          <circle className={styles.arcHighlight} cx="80" cy="80" r={RADIUS} fill="none" strokeWidth="1.5"
            strokeDasharray={CIRCUMFERENCE} strokeDashoffset={offset}
            style={{ opacity: clamped === 0 ? 0 : .65 }} />
        </svg>
        <div className={styles.ringCentre}>
          <p className={styles.percent}>{percent === null ? "—" : `${clamped}%`}</p>
          <p className={styles.percentLabel}>recovered</p>
        </div>
      </div>
    </div>
  );
}
