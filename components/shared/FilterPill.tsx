import { VaultIcon } from "@/components/shared/VaultIcon";
import styles from "./FilterPill.module.css";

type FilterPillProps = {
  label: string;
  removable?: boolean;
  onRemove?: () => void;
};

export function FilterPill({ label, removable = false, onRemove }: FilterPillProps) {
  if (removable) {
    return (
      <button type="button" className={styles.pillButton} onClick={onRemove}>
        <span>{label}</span>
        <span className={styles.closeMark} aria-hidden="true">
          <VaultIcon name="close" size={13} />
        </span>
      </button>
    );
  }

  return <span className={styles.pill}>{label}</span>;
}
