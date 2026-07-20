import styles from "./VaultOptionGroup.module.css";
import type React from "react";
import { BrandedIcon, type BrandedIconName } from "@/components/shared/BrandedIcon";
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
              <BrandedIcon group="selections" name={optionIconName(option.id)} size={38} className={styles.optionIcon} />
              <strong className={styles.optionLabel}>{option.label}</strong>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function optionIconName(id: string): BrandedIconName<"selections"> {
  const iconNames: Record<string, BrandedIconName<"selections">> = {
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

  return iconNames[id] ?? "surprise-me";
}

function groupIconName(title: string): VaultIconName {
  if (title === "Session") return "session";
  if (title === "Mood") return "mood";
  return "new";
}
