import { VaultIcon } from "@/components/shared/VaultIcon";
import { familyProvenance, isFamilyAccess } from "@/lib/family-sharing";
import type { DemoGame } from "@/lib/demo-data";
import styles from "./FamilyMark.module.css";

/**
 * The mark a family game wears.
 *
 * Shared rather than drawn per surface, because a game shows up in a lot of
 * places - the library grid, the pinned shelf, the Vault's pick and its deck,
 * draw history, the pin picker, collections, the finished shelf - and a mark
 * that only appears in some of them is worse than none: the player learns to
 * read its absence as "this one is mine", which is exactly wrong.
 *
 * `overlay` positions it in the corner of a piece of artwork. Anything else
 * places it inline, beside a title.
 */
export function FamilyMark({ title, overlay }: { title?: string; overlay?: boolean }) {
  return (
    <span className={overlay ? `${styles.mark} ${styles.overlay}` : styles.mark} title={title}>
      <VaultIcon name="family" size={13} />
    </span>
  );
}

/**
 * The same mark, but it decides for itself whether this game deserves one.
 *
 * One line at every call site, and no surface has to remember the rule for what
 * counts as a family game or how to word the tooltip.
 */
export function FamilyGameMark({
  game,
  overlay
}: {
  game: Pick<DemoGame, "accessSource" | "familyOwnerName">;
  overlay?: boolean;
}) {
  if (!isFamilyAccess(game.accessSource)) return null;
  return <FamilyMark overlay={overlay} title={familyProvenance(game) ?? undefined} />;
}
