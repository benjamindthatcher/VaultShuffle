"use client";

import { useEffect, useMemo, useState } from "react";
import { steamImageCandidates } from "@/lib/images";
import type { Game } from "@/lib/types";

export function HeroArtwork({ game }: { game: Game }) {
  const candidates = useMemo(() => {
    return [...steamImageCandidates(game, "header"), ...steamImageCandidates(game, "capsule")];
  }, [game.capsule_url, game.header_url, game.id, game.steam_appid]);
  const [imageIndex, setImageIndex] = useState(0);

  useEffect(() => {
    setImageIndex(0);
  }, [game.capsule_url, game.header_url, game.id, game.steam_appid]);

  const src = candidates[imageIndex];
  if (!src) return <Cover game={game} />;
  return <img src={src} alt="" loading="lazy" onError={() => setImageIndex((current) => current + 1)} />;
}

export function CollectionPreviewArtwork({ game }: { game: Game }) {
  const candidates = useMemo(() => {
    return [...steamImageCandidates(game, "capsuleLarge"), ...steamImageCandidates(game, "capsule")];
  }, [game.capsule_url, game.id, game.steam_appid]);
  const [imageIndex, setImageIndex] = useState(0);

  useEffect(() => {
    setImageIndex(0);
  }, [game.capsule_url, game.id, game.steam_appid]);

  const src = candidates[imageIndex];
  if (!src) return <Cover game={game} />;
  return (
    <img
      className="collection-preview-artwork"
      src={src}
      alt=""
      loading="lazy"
      onError={() => setImageIndex((current) => current + 1)}
    />
  );
}

export function Cover({ game, title }: { game?: Game; title?: string }) {
  const displayTitle = title || game?.title || "Game";
  const candidates = useMemo(() => steamImageCandidates(game, "capsule"), [game?.capsule_url, game?.id, game?.steam_appid]);
  const [imageIndex, setImageIndex] = useState(0);

  useEffect(() => {
    setImageIndex(0);
  }, [game?.capsule_url, game?.id, game?.steam_appid, displayTitle]);

  const src = candidates[imageIndex];

  return (
    <span className="cover">
      {src ? (
        <img src={src} alt="" loading="lazy" onError={() => setImageIndex((current) => current + 1)} />
      ) : (
        <span className="fallback-initials">{initials(displayTitle)}</span>
      )}
    </span>
  );
}

function initials(title: string) {
  return (
    title
      .replace(/[^a-zA-Z0-9 ]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0])
      .join("")
      .toUpperCase() || "VS"
  );
}
