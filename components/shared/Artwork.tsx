"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

type ArtworkProps = {
  src: string;
  fallbackSrc?: string;
  alt?: string;
  className?: string;
  sizes: string;
  priority?: boolean;
  fit?: "cover" | "contain";
};

const FALLBACK_ARTWORK = "/assets/vault/vault-stage-open.png";

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
  fallbackSrc = FALLBACK_ARTWORK,
  alt = "",
  className,
  sizes,
  priority = false,
  fit = "cover"
}: ArtworkProps) {
  const [resolvedSrc, setResolvedSrc] = useState(src || fallbackSrc);

  useEffect(() => {
    setResolvedSrc(src || fallbackSrc);
  }, [fallbackSrc, src]);

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
      onError={() => setResolvedSrc(fallbackSrc)}
    />
  );
}
