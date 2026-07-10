"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

type ArtworkProps = {
  src: string;
  alt?: string;
  className?: string;
  sizes: string;
  priority?: boolean;
};

const FALLBACK_ARTWORK = "/assets/vault/vault-stage-open.png";

export function Artwork({ src, alt = "", className, sizes, priority = false }: ArtworkProps) {
  const [resolvedSrc, setResolvedSrc] = useState(src || FALLBACK_ARTWORK);

  useEffect(() => {
    setResolvedSrc(src || FALLBACK_ARTWORK);
  }, [src]);

  return (
    <Image
      src={resolvedSrc}
      alt={alt}
      fill
      sizes={sizes}
      priority={priority}
      className={className}
      onError={() => setResolvedSrc(FALLBACK_ARTWORK)}
    />
  );
}
