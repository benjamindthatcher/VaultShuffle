import { ContentPage } from "@/components/ContentPage";

export default function PrivacyPage() {
  return (
    <ContentPage
      title="Privacy"
      intro="Vault Shuffle is designed around your Steam identity, your saved backlog, and a database you control through Supabase."
      panels={[
        {
          title: "Supabase Data",
          body: "Vault Shuffle stores Steam users, sessions, games, settings, and recommendation history in your Supabase project."
        },
        {
          title: "Steam Sign-In",
          body: "Steam sign-in is handled through Steam OpenID. Vault Shuffle receives your SteamID64, not your Steam password."
        },
        {
          title: "Steam Artwork",
          body: "If a game has a Steam AppID, the browser may request artwork from Steam's public image servers."
        },
        {
          title: "Future Hosting",
          body: "Before launching publicly, replace this project privacy page with a full policy covering analytics, support, retention, and account deletion."
        }
      ]}
    />
  );
}
