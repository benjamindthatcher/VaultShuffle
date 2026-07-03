import { ContentPage } from "@/components/ContentPage";

export default function TermsPage() {
  return (
    <ContentPage
      title="Terms"
      intro="Vault Shuffle is a personal game-library tool for choosing what to play next. These terms keep the boundaries simple."
      panels={[
        {
          title: "What It Does",
          body: "Vault Shuffle imports or saves games, lets you track progress and notes, and helps choose from the games currently visible in your library."
        },
        {
          title: "Steam And Publishers",
          body: "Vault Shuffle is not affiliated with Valve, Steam, or any game publisher. Steam names, logos, store links, artwork, and game metadata belong to their respective owners."
        },
        {
          title: "Your Account",
          body: "Steam sign-in is used only to identify your Steam account and import library data. You are responsible for deciding what data you add, edit, or delete inside the app."
        },
        {
          title: "Metadata Accuracy",
          body: "Game genres, length buckets, artwork, ratings, and playtime can be incomplete or wrong because they depend on Steam and other public metadata sources. You can still use Vault Shuffle when some metadata is missing."
        },
        {
          title: "Availability",
          body: "Vault Shuffle is a live portfolio project and may change over time. Features can be updated, adjusted, or removed as the project develops."
        },
        {
          title: "Fair Use",
          body: "Do not use Vault Shuffle to scrape, abuse, or overload Steam, Vercel, Supabase, or any connected service."
        },
        {
          title: "Deletion",
          body: "If you want stored account or library data removed, contact the project owner and it can be deleted from the hosted database."
        }
      ]}
    />
  );
}
