import type { DemoGame } from "@/lib/demo-data";
import { GameCard } from "@/components/shared/GameCard";
import styles from "./LibraryGameGrid.module.css";

type LibraryGameGridProps = {
  games: DemoGame[];
  viewMode: "grid" | "list";
  onSelect: (gameId: string) => void;
};

export function LibraryGameGrid({ games, viewMode, onSelect }: LibraryGameGridProps) {
  return (
    <div className={viewMode === "list" ? `${styles.grid} ${styles.gridList}` : styles.grid}>
      {games.map((game) => (
        <GameCard key={game.id} game={game} layout={viewMode} onClick={() => onSelect(game.id)} />
      ))}
    </div>
  );
}
