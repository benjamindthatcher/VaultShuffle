import type { ReactNode } from "react";
import { AppDataProvider } from "@/components/app-shell/AppDataProvider";
import { AppHeader } from "@/components/app-shell/AppHeader";
import styles from "./shell.module.css";

export default function AuthenticatedAppLayout({ children }: { children: ReactNode }) {
  return (
    <AppDataProvider>
      <div className={styles.appShell}>
        <AppHeader />
        <main className={styles.appContent}>{children}</main>
      </div>
    </AppDataProvider>
  );
}
