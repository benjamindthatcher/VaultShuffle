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

const EMPTY_QUEUE = { game: null, games: [], total: 0, reviewed: 0, remaining: 0 };

export default async function DurationQueuePage() {
  // Neither call may take the route down. hasDurationQueueAccess throws outright
  // when SESSION_SECRET is missing, and the queue read can fail on a slow count,
  // which used to render a dead page rather than something a reviewer can use.
  let allowed = false;
  try {
    allowed = await hasDurationQueueAccess();
  } catch (error) {
    console.error("Duration queue access check failed", error);
  }

  let initialState = null;
  if (allowed) {
    try {
      initialState = await getDurationReviewQueueState();
    } catch (error) {
      console.error("Duration review queue failed to load", error);
      initialState = EMPTY_QUEUE;
    }
  }

  return (
    <main className={styles.page}>
      {initialState ? <DurationReviewInterface initialState={initialState} /> : <DurationQueueGate />}
    </main>
  );
}
