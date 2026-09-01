import type { Metadata } from "next";
import { DurationQueueGate } from "@/components/duration-review/DurationQueueGate";
import { DurationReviewInterface } from "@/components/duration-review/DurationReviewInterface";
import { getDurationReviewQueueState, hasDurationQueueAccess } from "@/lib/duration-review";
import styles from "./durationqueue.module.css";

export const metadata: Metadata = {
  title: "Duration Queue",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false, noimageindex: true },
  },
};

export const dynamic = "force-dynamic";

export default async function DurationQueuePage() {
  const allowed = await hasDurationQueueAccess();
  const initialState = allowed ? await getDurationReviewQueueState() : null;

  return (
    <main className={styles.page}>
      {initialState ? <DurationReviewInterface initialState={initialState} /> : <DurationQueueGate />}
    </main>
  );
}
