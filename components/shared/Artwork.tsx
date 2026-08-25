"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { gameArtworkFallback } from "@/lib/vaultshuffle-assets";

type ArtworkProps = {
  src: string;
  /** Overrides the derived placeholder — a collection banner, usually. */
  fallbackSrc?: string;
  alt?: string;
  className?: string;
  sizes: string;
  priority?: boolean;
  fit?: "cover" | "contain";
};

/**
 * A game with no artwork gets one of the wide placeholder plates, picked from
 * its own source string so it is the same one every time. It used to get the
 * vault door, which is the brand's own image: on a shelf of Steam headers it
 * read as "this is VaultShuffle" rather than as "no picture for this one".
 */

/**
 * Steam already serves these at the exact sizes we render — capsule_231x87,
 * header.jpg at 460x215 — from its own CDN. Passing them through Vercel's
 * optimiser re-encodes an already-optimised image, and every unique
 * source x width x quality x format combination counts against a 1,000/month
 * allowance. A library of 2,000 games exhausts that on its own, so remote Steam
 * artwork is served directly and only local assets are optimised.
 */
function isSteamHosted(url: string) {
  return /^https?:\/\/[^/]*steamstatic\.com\//i.test(url);
}

export function Artwork({
  src,
  fallbackSrc,
  alt = "",
  className,
  sizes,
  priority = false,
  fit = "cover"
}: ArtworkProps) {
  const placeholder = fallbackSrc ?? gameArtworkFallback(src || alt);
  const [resolvedSrc, setResolvedSrc] = useState(src || placeholder);

  useEffect(() => {
    setResolvedSrc(src || placeholder);
  }, [placeholder, src]);

  return (
    <Image
      src={resolvedSrc}
      alt={alt}
      fill
      sizes={sizes}
      unoptimized={isSteamHosted(resolvedSrc)}
      priority={priority}
      className={className}
      style={{ objectFit: fit, objectPosition: "center" }}
      onError={() => setResolvedSrc(placeholder)}
    />
  );
}
