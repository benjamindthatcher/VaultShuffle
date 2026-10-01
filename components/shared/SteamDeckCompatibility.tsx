"use client";

import Image from "next/image";
import { useAppData } from "@/components/app-shell/AppDataProvider";
import { steamDeckRating } from "@/lib/steam-deck";
import styles from "./SteamDeckCompatibility.module.css";

type Props = { category: number | null | undefined };

export function SteamDeckBadge({ category }: Props) {
  const rating = steamDeckRating(category);
  return <span className={styles.badge} data-rating={rating.id} title={`Steam Deck: ${rating.label}. ${rating.description}`}>
    {rating.id === "missing"
      ? <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="4" /><path d="M9 6v12M15 6v12M5 12h1M18 12h1" /></svg>
      : <Image src={`/assets/steam-deck/${rating.id}.png`} alt="" width={18} height={18} unoptimized />}
    <span>Steam Deck · {rating.label}</span>
  </span>;
}

/** Keep catalogue cards quiet until the user chooses Steam Deck. */
export function FilteredSteamDeckBadge(props: Props) {
  const { globalFilters } = useAppData();
  return globalFilters.device === "deck" ? <SteamDeckBadge {...props} /> : null;
}

export function SteamDeckDetails({ category }: Props) {
  const rating = steamDeckRating(category);
  return <section className={styles.details} aria-label="Steam Deck compatibility">
    <SteamDeckBadge category={category} />
    <p>{rating.description}</p>
  </section>;
}
