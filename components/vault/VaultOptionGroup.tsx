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
  stepNumber: number;
  options: readonly VaultOption[];
  selectedId: string | null;
  selectedLabel: string | null;
  expanded: boolean;
  state: "active" | "complete" | "pending";
  onSelect: (id: string) => void;
  onToggle: () => void;
  lockedOptionIds?: readonly string[];
  onLockedSelect?: (id: string) => void;
};

export function VaultOptionGroup({
  title,
  stepNumber,
  options,
  selectedId,
  selectedLabel,
  expanded,
  state,
  onSelect,
  onToggle,
  lockedOptionIds = [],
  onLockedSelect
}: VaultOptionGroupProps) {
  const groupId = `vault-setup-${title.toLowerCase()}`;
  const optionsId = `${groupId}-options`;

  return (
    <section className={styles.group} id={groupId} data-state={state} data-expanded={expanded || undefined}>
      <h2 className={styles.headingRow}>
        <button type="button" className={styles.headingButton} aria-expanded={expanded} aria-controls={optionsId} onClick={onToggle}>
          <span className={styles.stepNumber} aria-hidden="true">
            {state === "complete" ? <VaultIcon name="check" size={17} /> : stepNumber}
          </span>
          <VaultIcon name={groupIconName(title)} className={styles.groupIcon} />
          <span className={styles.headingCopy}>
            <strong>{title}</strong>
            <small>{selectedLabel ?? (state === "active" ? "Choose one to continue" : "Required choice")}</small>
          </span>
          <span className={styles.stateLabel}>{state === "complete" ? "Ready" : state === "active" ? "Choose one" : "Required"}</span>
          <VaultIcon name="chevron-down" size={18} className={styles.headingChevron} />
        </button>
      </h2>

      {expanded ? <div id={optionsId} className={styles.optionGrid} style={{ "--option-count": options.length } as React.CSSProperties}>
        {options.map((option) => {
          const isActive = option.id === selectedId;
          const isLocked = lockedOptionIds.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              className={`${styles.optionButton}${isActive ? ` ${styles.optionButtonActive}` : ""}${isLocked ? ` ${styles.optionButtonLocked}` : ""}`}
              aria-pressed={isActive}
              aria-label={isLocked ? `${option.label}. Uses your Steam playtime; the rest of the preview stays available.` : option.label}
              onClick={() => isLocked ? onLockedSelect?.(option.id) : onSelect(option.id)}
            >
              <VaultIcon name={optionIconName(option.id)} size={38} className={styles.optionIcon} />
              <strong className={styles.optionLabel}>{option.label}</strong>
              {isLocked ? <span className={styles.lockMark} title="Uses your Steam playtime"><VaultIcon name="privacy" size={14} /></span> : null}
            </button>
          );
        })}
      </div> : null}
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

  return iconNames[id] ?? "surprise-me";
}

function groupIconName(title: string): VaultIconName {
  if (title === "Session") return "session";
  if (title === "Mood") return "mood";
  return "new";
}
