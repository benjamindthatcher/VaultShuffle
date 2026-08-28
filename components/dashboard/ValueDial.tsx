import styles from "./ValueDial.module.css";

const RADIUS = 62;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const TICKS = 40;

type ValueDialProps = {
  percent: number;
  completedValue: string;
  libraryValue: string;
  completedGames: number;
  totalGames: number;
};

export function ValueDial({ percent, completedValue, libraryValue, completedGames, totalGames }: ValueDialProps) {
  const clamped = Math.max(0, Math.min(100, percent));
  const offset = CIRCUMFERENCE * (1 - clamped / 100);
  const litTicks = Math.round((clamped / 100) * TICKS);
  const dialStyle = {
    "--dial-progress": `${clamped}%`
  } as React.CSSProperties;

  return (
    <section
      className={styles.dial}
      aria-label={`${completedValue} of ${libraryValue} finished, ${clamped}% of your library's value`}
      style={dialStyle}
    >
      <div className={styles.copy}>
        <p className={styles.label}>Library value completed</p>
        <p className={styles.value}>{completedValue}</p>
        <p className={styles.total}>of <strong>{libraryValue}</strong> library value</p>
      </div>

      <div className={styles.dialColumn}>
        <div className={styles.ringWrap}>
          <svg className={styles.ring} viewBox="0 0 160 160" aria-hidden="true">
            <defs>
              <linearGradient id="vaultDialStroke" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#6ee7b7" />
                <stop offset="46%" stopColor="#a855f7" />
                <stop offset="100%" stopColor="#4d7cff" />
              </linearGradient>
              <linearGradient id="vaultBezelStroke" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#b983ff" stopOpacity="0.88" />
                <stop offset="45%" stopColor="#3b236e" stopOpacity="0.5" />
                <stop offset="100%" stopColor="#7654d6" stopOpacity="0.78" />
              </linearGradient>
            </defs>

            <circle className={styles.bezelOuter} cx="80" cy="80" r="76" fill="none" strokeWidth="1" />
            <circle className={styles.bezelInner} cx="80" cy="80" r="70" fill="none" strokeWidth="4" />

            {Array.from({ length: TICKS }, (_, index) => {
              const angle = (index / TICKS) * 2 * Math.PI;
              const inner = index % 5 === 0 ? 44 : 48;
              return (
                <line
                  key={index}
                  className={index < litTicks ? styles.tickLive : styles.tick}
                  x1={80 + Math.cos(angle) * inner}
                  y1={80 + Math.sin(angle) * inner}
                  x2={80 + Math.cos(angle) * 52}
                  y2={80 + Math.sin(angle) * 52}
                  strokeWidth={index % 5 === 0 ? 2 : 1}
                />
              );
            })}

            <circle className={styles.ringTrack} cx="80" cy="80" r={RADIUS} fill="none" strokeWidth="10" />
            <circle
              className={styles.ringFill}
              cx="80"
              cy="80"
              r={RADIUS}
              fill="none"
              strokeWidth="10"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={offset}
              style={{
                "--dial-offset": `${offset}`,
                "--dial-empty": `${CIRCUMFERENCE}`
              } as React.CSSProperties}
            />
          </svg>

          <div className={styles.ringCentre}>
            <p className={styles.percent}>{clamped}%</p>
            <p className={styles.percentLabel}>recovered</p>
          </div>
        </div>
      </div>

      <div className={styles.games}>
        <p className={styles.label}>Games finished</p>
        <p className={styles.gameCount}>{completedGames}<span> / {totalGames}</span></p>
        <p className={styles.hint}>cleared from your library</p>
      </div>

      <div className={styles.progressTrack} aria-hidden="true">
        {clamped > 0 ? <span className={styles.progressFill} /> : null}
      </div>
    </section>
  );
}
