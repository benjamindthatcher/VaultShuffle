import { VaultIcon, type VaultIconName } from "@/components/shared/VaultIcon";

type StatIconProps = {
  label: string;
};

export function StatIcon({ label }: StatIconProps) {
  return <VaultIcon name={iconName(label)} size={31} />;
}

function iconName(label: string): VaultIconName {
  const key = label.toLowerCase();
  if (key.includes("all games")) return "all-games";
  if (key.includes("played")) return "played";
  if (key.includes("backlog")) return "backlog";
  if (key.includes("completed")) return "completed";
  if (key.includes("progress")) return "in-progress";
  if (key.includes("paused")) return "paused";
  if (key.includes("wishlist")) return "wishlist";
  if (key.includes("sale")) return "on-sale";
  if (key.includes("in library")) return "in-library";
  if (key.includes("following")) return "following";
  if (key.includes("smart")) return "smart-collections";
  if (key.includes("custom")) return "custom-collections";
  if (key.includes("games in collections")) return "games-in-collections";
  if (key.includes("collections")) return "collections";
  return "all-games";
}
