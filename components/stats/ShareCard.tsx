"use client";

import { useRef, useState } from "react";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { VaultIcon } from "@/components/shared/VaultIcon";
import { buildBacklogStats } from "@/lib/backlog-stats";
import { buildShareCard, drawShareCard, SHARE_CARD_HEIGHT, SHARE_CARD_WIDTH } from "@/lib/share-card";
import styles from "./ShareCard.module.css";

type Mode = "idle" | "drawing" | "ready";

/**
 * A card worth posting, made only when it is asked for.
 *
 * Drawing on mount meant every dashboard visit fetched four Steam covers and
 * painted a 1200x630 canvas for a feature most people will not use on most
 * visits. It also put the artefact on screen before anyone expressed interest in
 * it, which is the wrong way round for something whose entire purpose is being
 * deliberately shared.
 *
 * Nothing is published either way: the image is generated on the device and the
 * player decides where it goes, so a shareable artefact never quietly becomes a
 * privacy decision taken on their behalf.
 */
export function ShareCard() {
  const { games, playtime, session, isLive } = useAppData();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<Mode>("idle");
  const [status, setStatus] = useState<"none" | "copied" | "saved" | "failed">("none");

  const stats = buildBacklogStats(games);
  const displayName = session.display_name || "Steam player";

  async function create() {
    if (mode === "drawing") return;
    setMode("drawing");
    setStatus("none");

    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) { setMode("idle"); return; }

    const content = buildShareCard(stats, playtime.streakDays, games);

    // Painted once without art so there is something the instant it appears,
    // then again with whatever loaded. Steam's CDN sends
    // access-control-allow-origin, so crossOrigin keeps the canvas exportable —
    // a tainted canvas would break Copy and Download silently.
    context.clearRect(0, 0, canvas.width, canvas.height);
    drawShareCard(context, content, displayName);
    setMode("ready");

    if (!content.artwork.length) return;
    const images = await Promise.all(content.artwork.map((url) => new Promise<HTMLImageElement | null>((resolve) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = () => resolve(image);
      // A cover that will not load simply leaves its slot out.
      image.onerror = () => resolve(null);
      image.src = url;
    })));

    context.clearRect(0, 0, canvas.width, canvas.height);
    drawShareCard(context, content, displayName, images);
  }

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
      // Not available in every browser, which is why Download exists.
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
  const ready = mode === "ready";

  return (
    <section className={ready ? styles.panel : styles.panelIdle} aria-labelledby="share-card-title">
      {/* Kept mounted but hidden so the canvas exists to draw into on request. */}
      <div className={styles.preview} hidden={!ready}>
        <canvas
          ref={canvasRef}
          width={SHARE_CARD_WIDTH}
          height={SHARE_CARD_HEIGHT}
          className={styles.canvas}
          role="img"
          aria-label={`Your backlog card. ${stats.valueCompletedPercent}% of your library's value finished.`}
        />
      </div>

      <div className={styles.body}>
        <p className={styles.eyebrow}>Share</p>
        <h2 id="share-card-title">Your backlog, as a card</h2>
        <p className={styles.copyNote}>
          {ready
            ? "Made on your device. Nothing is published unless you post it yourself."
            : "Turn your finished games and library value into an image you can post."}
        </p>

        <div className={styles.actions}>
          {ready ? (
            <>
              <button type="button" className={styles.primary} onClick={() => void copy()}>
                <VaultIcon name="check" size={16} />{status === "copied" ? "Copied" : "Copy image"}
              </button>
              <button type="button" className={styles.secondary} onClick={() => void download()}>
                {status === "saved" ? "Saved" : "Download"}
              </button>
            </>
          ) : (
            <button type="button" className={styles.primary} disabled={mode === "drawing"} onClick={() => void create()}>
              <VaultIcon name="new" size={16} />{mode === "drawing" ? "Making it…" : "Make my card"}
            </button>
          )}
        </div>

        {status === "failed" ? (
          <p className={styles.failed} role="alert">
            Copying is not supported in this browser — use Download instead.
          </p>
        ) : null}
      </div>
    </section>
  );
}
