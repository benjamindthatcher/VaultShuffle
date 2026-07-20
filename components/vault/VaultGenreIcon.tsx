import { BrandedIcon } from "@/components/shared/BrandedIcon";
import type { VaultGenre } from "@/lib/vault-genres";

export function VaultGenreIcon({ genre, size = 19 }: { genre: VaultGenre; size?: number }) {
  return <BrandedIcon group="genres" name={genre.id} size={size} />;
}
