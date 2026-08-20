import type { BacklogStats } from "./backlog-stats.ts";
import { formatHours, formatMoney } from "./backlog-stats.ts";
import type { DemoGame } from "./demo-data.ts";

export type ShareCardLine = { label: string; value: string };

export type ShareCardContent = {
  headline: string;
  subhead: string;
  percent: number;
  lines: ShareCardLine[];
  /** Cover art for the strip along the bottom. Steam's CDN allows CORS, so these
   *  can be drawn without tainting the canvas and blocking export. */
  artwork: string[];
  artworkLabel: string;
};

/**
 * What a backlog card should actually boast about.
 *
 * Value completed leads because it is the number that moves, and the one a rival
 * charges to look at. Hours are included because they are exact where money is an
 * estimate, and "never opened" is included because a backlog card that only shows
 * triumphs is not recognisable to anyone who has a backlog.
 */
export function buildShareCard(stats: BacklogStats, streakDays: number, games: DemoGame[] = []): ShareCardContent {
  // What was finished is the part worth showing off. Falling back to the best
  // value for money keeps the card from looking empty before anything is done.
  const finished = games
    .filter((game) => game.status === "Completed" && game.completedAt && game.bannerUrl)
    .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)));

  const fallback = games
    .filter((game) => game.bannerUrl && game.hoursPlayed >= 1)
    .sort((left, right) => right.hoursPlayed - left.hoursPlayed);

  const showcase = (finished.length ? finished : fallback).slice(0, 4);

  return {
    artwork: showcase.map((game) => game.bannerUrl).filter((url): url is string => Boolean(url)),
    artworkLabel: finished.length ? "Recently finished" : "Most played",
    headline: `${formatMoney(stats.completedValueCents, stats.currency)} of ${formatMoney(stats.libraryValueCents, stats.currency)} finished`,
    subhead: stats.bestValue
      ? `Best value: ${stats.bestValue.title}`
      : `${stats.totalGames} games in the vault`,
    percent: stats.valueCompletedPercent,
    lines: [
      { label: "Games finished", value: `${stats.completedGames} of ${stats.totalGames}` },
      { label: "Hours played", value: formatHours(stats.totalHours) },
      { label: "Never opened", value: String(stats.unplayedGames) },
      ...(streakDays > 0 ? [{ label: "Play streak", value: `${streakDays}d` }] : [])
    ]
  };
}

/** Canvas size matching the usual link-preview aspect, so it looks right when posted. */
export const SHARE_CARD_WIDTH = 1200;
export const SHARE_CARD_HEIGHT = 630;

/**
 * Painted directly onto a canvas rather than screenshotting the DOM.
 *
 * Rasterising live markup needs a heavy dependency and reproduces whatever the
 * page happens to look like at that size; drawing it explicitly gives one fixed,
 * predictable image and adds nothing to the bundle.
 */
export function drawShareCard(
  context: CanvasRenderingContext2D,
  content: ShareCardContent,
  displayName: string,
  artwork: Array<CanvasImageSource | null> = []
) {
  const width = SHARE_CARD_WIDTH;
  const height = SHARE_CARD_HEIGHT;

  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "#0b0f24");
  background.addColorStop(0.55, "#161033");
  background.addColorStop(1, "#0a0d1f");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  context.strokeStyle = "rgba(142, 77, 255, 0.42)";
  context.lineWidth = 2;
  context.strokeRect(1, 1, width - 2, height - 2);

  context.fillStyle = "#d392ff";
  context.font = "600 26px system-ui, -apple-system, Segoe UI, sans-serif";
  context.fillText("VAULTSHUFFLE", 64, 92);

  context.fillStyle = "rgba(226, 232, 255, 0.66)";
  context.font = "500 26px system-ui, -apple-system, Segoe UI, sans-serif";
  context.fillText(displayName, 64, 136);

  context.fillStyle = "#f2f4ff";
  context.font = "800 62px system-ui, -apple-system, Segoe UI, sans-serif";
  context.fillText(content.headline, 64, 236);

  context.fillStyle = "rgba(226, 232, 255, 0.72)";
  context.font = "500 28px system-ui, -apple-system, Segoe UI, sans-serif";
  context.fillText(content.subhead, 64, 284);

  // Progress bar
  const barY = 330;
  const barWidth = width - 128;
  context.fillStyle = "rgba(134, 91, 255, 0.24)";
  roundedRect(context, 64, barY, barWidth, 18, 9);
  context.fill();

  const fillWidth = Math.max(barWidth * (content.percent / 100), 10);
  const fill = context.createLinearGradient(64, 0, 64 + fillWidth, 0);
  fill.addColorStop(0, "#7ce7b2");
  fill.addColorStop(1, "#b57cff");
  context.fillStyle = fill;
  roundedRect(context, 64, barY, fillWidth, 18, 9);
  context.fill();

  context.fillStyle = "rgba(226, 232, 255, 0.62)";
  context.font = "600 22px system-ui, -apple-system, Segoe UI, sans-serif";
  context.fillText(`${content.percent}% of the library's value finished`, 64, barY + 54);

  // Stat columns
  const columnWidth = barWidth / Math.max(1, content.lines.length);
  content.lines.forEach((line, index) => {
    const x = 64 + columnWidth * index;
    context.fillStyle = "rgba(226, 232, 255, 0.56)";
    context.font = "600 19px system-ui, -apple-system, Segoe UI, sans-serif";
    context.fillText(line.label.toUpperCase(), x, 434);
    context.fillStyle = "#f2f4ff";
    context.font = "800 40px system-ui, -apple-system, Segoe UI, sans-serif";
    context.fillText(line.value, x, 478);
  });

  const drawable = artwork.filter(Boolean) as CanvasImageSource[];
  if (drawable.length) {
    context.fillStyle = "rgba(226, 232, 255, 0.5)";
    context.font = "600 18px system-ui, -apple-system, Segoe UI, sans-serif";
    context.fillText(content.artworkLabel.toUpperCase(), 64, 524);

    const gap = 16;
    const tileWidth = (barWidth - gap * (drawable.length - 1)) / drawable.length;
    const tileHeight = Math.min(78, tileWidth * (43 / 92));
    drawable.forEach((image, index) => {
      const x = 64 + (tileWidth + gap) * index;
      context.save();
      roundedRect(context, x, 542, tileWidth, tileHeight, 10);
      context.clip();
      // Cover-fit: Steam headers are 92:43, so anything squarer is cropped rather
      // than squashed.
      context.drawImage(image, x, 542, tileWidth, tileHeight);
      context.restore();
      context.strokeStyle = "rgba(255, 255, 255, 0.12)";
      context.lineWidth = 1;
      roundedRect(context, x, 542, tileWidth, tileHeight, 10);
      context.stroke();
    });
  }

  context.fillStyle = "rgba(226, 232, 255, 0.44)";
  context.font = "500 20px system-ui, -apple-system, Segoe UI, sans-serif";
  context.fillText("vaultshuffle.com", width - 240, height - 34);
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}
