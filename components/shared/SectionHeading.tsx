import type { ReactNode } from "react";
import styles from "./SectionHeading.module.css";

type SectionHeadingProps = {
  title: string;
  /** A count or one short phrase about the section's contents. */
  meta?: ReactNode;
  /** Controls belonging to this section, shown on the right. */
  action?: ReactNode;
  id?: string;
};

export function SectionHeading({ title, meta, action, id }: SectionHeadingProps) {
  return (
    <div className={styles.row}>
      <h2 className={styles.title} id={id}>
        {title}
        {meta ? <span className={styles.meta}>{meta}</span> : null}
      </h2>
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
