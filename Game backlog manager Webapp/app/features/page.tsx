import { ContentPage } from "@/components/ContentPage";

export default function FeaturesPage() {
  return (
    <ContentPage
      title="Everything you need to choose tonight's game."
      intro="Vault Shuffle keeps the useful tracker features close to the actual decision: what should I play next?"
      panels={[
        {
          title: "Steam Sign-In",
          body: "Use Steam OpenID once, then come straight back to the app with your session remembered in Supabase."
        },
        {
          title: "Smart Shuffle",
          body: "Pick by vibe and time, then roll from unfinished owned games instead of the whole library."
        },
        {
          title: "Visual Library",
          body: "Steam AppIDs pull artwork into the list and details panel so your backlog feels like games again."
        },
        {
          title: "Focused Filters",
          body: "Status, ownership, search, hide completed, and sorting help narrow a huge library without losing context."
        },
        {
          title: "Supabase Database",
          body: "Games, users, sessions, settings, and recommendation history are stored in Supabase Postgres."
        },
        {
          title: "Built For Big Lists",
          body: "The game list scrolls inside the app, keeping controls and details fixed around it."
        }
      ]}
    />
  );
}
