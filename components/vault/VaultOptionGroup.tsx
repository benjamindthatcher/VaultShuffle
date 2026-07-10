import styles from "./VaultOptionGroup.module.css";

type VaultOption = {
  id: string;
  label: string;
  caption: string;
};

type VaultOptionGroupProps = {
  title: string;
  options: readonly VaultOption[];
  selectedId: string;
  onSelect: (id: string) => void;
};

export function VaultOptionGroup({ title, options, selectedId, onSelect }: VaultOptionGroupProps) {
  return (
    <section className={styles.group}>
      <div className={styles.headingRow}>
        <p className={styles.stepLabel}>{title}</p>
      </div>

      <div className={styles.optionGrid}>
        {options.map((option) => {
          const isActive = option.id === selectedId;
          return (
            <button
              key={option.id}
              type="button"
              className={isActive ? `${styles.optionButton} ${styles.optionButtonActive}` : styles.optionButton}
              aria-pressed={isActive}
              onClick={() => onSelect(option.id)}
            >
              <strong className={styles.optionLabel}>{option.label}</strong>
              <span className={styles.optionCaption}>{option.caption}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
