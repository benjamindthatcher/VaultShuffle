import type { DemoGame } from "@/lib/demo-data";
import { GameCard } from "@/components/shared/GameCard";
import styles from "./LibraryGameGrid.module.css";

type LibraryGameGridProps = {
  games: DemoGame[];
  viewMode: "grid" | "list";
  onSelect: (gameId: string) => void;
  onComplete: (gameId: string) => void;
  onRestore: (gameId: string) => void;
  onSleep: (gameId: string) => void;
  onTogglePin: (game: DemoGame) => void;
  pinnedIds: string[];
};

export function LibraryGameGrid({ games, viewMode, onSelect, onComplete, onRestore, onSleep, onTogglePin, pinnedIds = [] }: LibraryGameGridProps) {
  return (
    <div className={viewMode === "list" ? `${styles.grid} ${styles.gridList}` : styles.grid}>
      {games.map((game) => (
        <GameCard
          key={game.id}
          game={game}
          layout={viewMode}
          onClick={() => onSelect(game.id)}
          onComplete={game.status !== "Completed" ? () => onComplete(game.id) : undefined}
          onRestore={game.status === "Completed" ? () => onRestore(game.id) : undefined}
          onSleep={game.status !== "Completed" && game.status !== "Slept" ? () => onSleep(game.id) : undefined}
          onTogglePin={game.status !== "Completed" && game.status !== "Slept" ? () => onTogglePin(game) : undefined}
          pinned={pinnedIds.includes(game.id)}
          showProgress
        />
      ))}
    </div>
  );
}
