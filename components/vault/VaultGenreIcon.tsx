import type { CSSProperties } from "react";
import type { VaultGenre } from "@/lib/vault-genres";

export function VaultGenreIcon({ genre, size = 19 }: { genre: VaultGenre; size?: number }) {
  const style = {
    width: size,
    height: size,
    flex: "0 0 auto",
    backgroundColor: "currentColor",
    mask: `url(${genre.icon}) center / contain no-repeat`,
    WebkitMask: `url(${genre.icon}) center / contain no-repeat`
  } as CSSProperties;

  return <span aria-hidden="true" style={style} />;
}
