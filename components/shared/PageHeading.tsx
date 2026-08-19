import type { ReactNode } from "react";
import styles from "./PageHeading.module.css";

type PageHeadingProps = {
  eyebrow: string;
  title: string;
  /** One sentence on what the page is for. */
  children?: ReactNode;
  /** A single control belonging to the page as a whole, shown beside the title. */
  action?: ReactNode;
};

export function PageHeading({ eyebrow, title, children, action }: PageHeadingProps) {
  return (
    <header className={`${styles.header}${action ? ` ${styles.withAction}` : ""}`}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h1>{title}</h1>
      {children ? <p className={styles.sub}>{children}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </header>
  );
}
