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
      priority={priority}
      className={className}
      style={{ objectFit: fit, objectPosition: "center" }}
      onError={() => setResolvedSrc(fallbackSrc)}
    />
  );
}
