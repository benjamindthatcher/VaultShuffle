import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ThemeWorkshop } from "./ThemeWorkshop";
import { themes } from "./themes";

export const metadata: Metadata = {
  title: "Theme workshop",
  robots: { index: false, follow: false },
};

export default async function ThemeWorkshopPage({ searchParams }: { searchParams: Promise<{ theme?: string }> }) {
  // Like Button Studio, proposals are kept out of the production site.
  if (process.env.NODE_ENV !== "development") notFound();
  const { theme } = await searchParams;
  return <ThemeWorkshop initialTheme={Math.max(0, themes.findIndex((item) => item.id === theme))} />;
}
