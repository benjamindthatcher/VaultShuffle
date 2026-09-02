import { VaultIcon } from "@/components/shared/VaultIcon";
import styles from "./FamilyMark.module.css";

/**
 * The mark a family game wears.
 *
 * Shared rather than drawn twice, because it appears in two places that must
 * agree: on the artwork of every shared game, and as a legend in the Family
 * library card - where the point is precisely that somebody can see what they
 * are being told to look for. A sentence saying "marked with a family icon" is
 * useless to a person who has never seen the icon, and if the legend and the
 * real badge ever drifted apart it would be worse than useless.
 */
export function FamilyMark({ title }: { title?: string }) {
  return (
    <span className={styles.mark} title={title}>
      <VaultIcon name="family" size={13} />
    </span>
  );
}
