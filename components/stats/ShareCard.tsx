"use client";

import { useEffect, useRef, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { buildBacklogStats } from "@/lib/backlog-stats";
import { buildShareCard, drawShareCard, SHARE_CARD_HEIGHT, SHARE_CARD_WIDTH } from "@/lib/share-card";
import styles from "./ShareCard.module.css";

/**
 * A card worth posting, generated on the device.
 *
 * Nothing is published: there is no public profile and no URL that exposes a
 * library. The player gets an image and decides for themselves where it goes,
 * which keeps a genuinely shareable artefact from quietly becoming a privacy
 * decision made on their behalf.
 */
export function ShareCard() {
  const { games, playtime, session, isLive } = useAppData();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<"idle" | "copied" | "saved" | "failed">("idle");

  const stats = buildBacklogStats(games);
  const content = buildShareCard(stats, playtime.streakDays, games);
  const displayName = session.display_name || "Steam player";

  const artworkKey = content.artwork.join("|");
  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    // Drawn once without art so the card is never blank while covers load, then
    // again with whatever arrived. Steam's CDN sends access-control-allow-origin,
    // so crossOrigin keeps the canvas exportable.
    context.clearRect(0, 0, canvas.width, canvas.height);
    drawShareCard(context, content, displayName);

    const urls = artworkKey ? artworkKey.split("|") : [];
    if (!urls.length) return;

    void Promise.all(urls.map((url) => new Promise<HTMLImageElement | null>((resolve) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = () => resolve(image);
      // A cover that will not load simply leaves its slot out.
      image.onerror = () => resolve(null);
      image.src = url;
    }))).then((images) => {
      if (cancelled) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      drawShareCard(context, content, displayName, images);
    });

    return () => { cancelled = true; };
  }, [artworkKey, content, displayName]);

  async function withBlob(handler: (blob: Blob) => Promise<void> | void) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) { setStatus("failed"); return; }
    try {
      await handler(blob);
    } catch {
      setStatus("failed");
    }
  }

  async function copy() {
    await withBlob(async (blob) => {
      // Not universally available, and a failure here is why Download exists.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setStatus("copied");
    });
  }

  async function download() {
    await withBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "vaultshuffle-backlog.png";
      link.click();
      URL.revokeObjectURL(url);
      setStatus("saved");
    });
  }

  if (!isLive || !stats.totalGames) return null;

  return (
    <section className={styles.panel} aria-labelledby="share-card-title">
      <div className={styles.head}>
        <div>
          <p className={styles.eyebrow}>Share</p>
          <h2 id="share-card-title">Your backlog, as a card</h2>
          <p className={styles.copyNote}>
            Made on your device. Nothing is published unless you post it yourself.
          </p>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={() => void copy()}>
            <VaultIcon name="check" size={16} />{status === "copied" ? "Copied" : "Copy image"}
          </button>
          <button type="button" className={styles.secondary} onClick={() => void download()}>
            {status === "saved" ? "Saved" : "Download"}
          </button>
        </div>
      </div>

      <div className={styles.preview}>
        <canvas
          ref={canvasRef}
          width={SHARE_CARD_WIDTH}
          height={SHARE_CARD_HEIGHT}
          className={styles.canvas}
          role="img"
          aria-label={`${content.headline}. ${content.percent}% of your library's value finished.`}
        />
      </div>

      {status === "failed" ? (
        <p className={styles.failed} role="alert">
          Copying is not supported in this browser — use Download instead.
        </p>
      ) : null}
    </section>
  );
}
