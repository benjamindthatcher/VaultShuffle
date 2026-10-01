export const themes = [
  {
    id: "midnight-iris", name: "Midnight Iris", mood: "Balanced · calm · focused",
    description: "Deep navy foundations, softly violet surfaces and a clear lavender accent. The most balanced bridge between the landing page and the app.",
    ground: "#090e20", chrome: "#0d1228", surface: "#171c35", feature: "#242344", well: "#10152c",
    border: "#383f61", accent: "#aa8aff", blue: "#729dff", text: "#f3f1ff", muted: "#b3b9d1",
  },
  {
    id: "velvet", name: "Velvet", mood: "Purple · warm · expressive",
    description: "Aubergine foundations and layered plum surfaces. A stronger purple identity, with blue kept as a cool counterpoint in the details.",
    ground: "#140e23", chrome: "#1b132e", surface: "#281d3e", feature: "#3a2856", well: "#1d142f",
    border: "#57416e", accent: "#d0a0ff", blue: "#9ea8ff", text: "#fbf3ff", muted: "#c7b7d8",
  },
  {
    id: "blue-hour", name: "Blue Hour", mood: "Blue · crisp · spacious",
    description: "Ink-blue foundations and brighter marine surfaces. Violet still owns actions and selection; blue brings clarity to information and charts.",
    ground: "#071426", chrome: "#0b1b31", surface: "#142b46", feature: "#24365b", well: "#0d2038",
    border: "#3d5a79", accent: "#b8a3ff", blue: "#7abfff", text: "#f0f6ff", muted: "#b0c5df",
  },
] as const;

export const paletteRoles = [
  ["ground", "Ground"], ["surface", "Surface"], ["feature", "Feature"],
  ["border", "Border"], ["accent", "Violet"], ["blue", "Blue"], ["text", "Text"],
] as const;

// Fixed design fixtures from the existing local dashboard preview. No account
// provider, mutations, or user library is involved in the workshop.
export const sampleGames = [
  { id: 553850, title: "HELLDIVERS™ 2", hours: 180, rate: "$0.22", price: "$39.99", date: "", genre: "Co-op · Action" },
  { id: 550, title: "Left 4 Dead 2", hours: 42, rate: "$0.24", price: "$9.99", date: "22 Sept 2026", genre: "Co-op · Survival" },
  { id: 1623730, title: "Palworld", hours: 120, rate: "$0.25", price: "$29.99", date: "24 Sept 2026", genre: "Adventure · Survival" },
  { id: 2358720, title: "Black Myth: Wukong", hours: 64, rate: "$0.94", price: "$59.99", date: "23 Sept 2026", genre: "Action · RPG" },
  { id: 2246340, title: "Monster Hunter Wilds", hours: 28, rate: "$1.43", price: "$39.99", date: "21 Sept 2026", genre: "Action · RPG" },
];

export const filterGroups = [
  { label: "Release age", options: ["Any", "Last 2 years", "Last 5 years", "5 years+", "Classics"] },
  { label: "How you play", options: ["Any", "Single-player", "Co-op", "Multiplayer"] },
  { label: "Game type", options: ["All", "Has an ending", "Endless"] },
  { label: "Device", options: ["Any device", "Mac", "Linux", "Steam Deck"] },
];
