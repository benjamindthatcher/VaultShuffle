export const VAULT_GENRES = [
  { id: "action", label: "Action", icon: "/assets/vaultshuffle/genres/action.svg" },
  { id: "adventure", label: "Adventure", icon: "/assets/vaultshuffle/genres/adventure.svg" },
  { id: "casual", label: "Casual", icon: "/assets/vaultshuffle/genres/casual.svg" },
  { id: "indie", label: "Indie", icon: "/assets/vaultshuffle/genres/indie.svg" },
  { id: "racing", label: "Racing", icon: "/assets/vaultshuffle/genres/racing.svg" },
  { id: "rpg", label: "RPG", icon: "/assets/vaultshuffle/genres/rpg.svg" },
  { id: "simulation", label: "Simulation", icon: "/assets/vaultshuffle/genres/simulation.svg" },
  { id: "sports", label: "Sports", icon: "/assets/vaultshuffle/genres/sports.svg" },
  { id: "strategy", label: "Strategy", icon: "/assets/vaultshuffle/genres/strategy.svg" }
] as const;

export type VaultGenre = (typeof VAULT_GENRES)[number];
