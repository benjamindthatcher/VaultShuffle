import { VaultIcon } from "@/components/shared/VaultIcon";
import type { VaultGenre } from "@/lib/vault-genres";

export function VaultGenreIcon({ genre, size = 19 }: { genre: VaultGenre; size?: number }) {
  return <VaultIcon name={genre.id} size={size} />;
}
