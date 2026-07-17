import styles from "./VaultOptionGroup.module.css";
import type React from "react";
import { VaultIcon, type VaultIconName } from "@/components/shared/VaultIcon";

type VaultOption = {
  id: string;
  label: string;
  caption: string;
};

type VaultOptionGroupProps = {
  title: string;
  options: readonly VaultOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
};

export function VaultOptionGroup({ title, options, selectedId, onSelect }: VaultOptionGroupProps) {
  return (
    <section className={styles.group}>
      <div className={styles.headingRow}>
        <VaultIcon name={groupIconName(title)} className={styles.groupIcon} />
        <p className={styles.stepLabel}>{title}</p>
      </div>

      <div className={styles.optionGrid} style={{ "--option-count": options.length } as React.CSSProperties}>
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
              <VaultIcon name={optionIconName(option.id)} className={styles.optionIcon} />
              <strong className={styles.optionLabel}>{option.label}</strong>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function optionIconName(id: string): VaultIconName {
  const iconNames: Record<string, VaultIconName> = {
    short: "short-session",
    evening: "evening-session",
    weekend: "weekend-session",
    "brain-off": "brain-off",
    chill: "chill",
    intense: "intense",
    new: "something-new",
    finish: "finish-something",
    surprise: "surprise-me"
  };

  return iconNames[id] ?? "goal";
}

function groupIconName(title: string): VaultIconName {
  if (title === "Session") return "session";
  if (title === "Mood") return "mood";
  return "new";
}
