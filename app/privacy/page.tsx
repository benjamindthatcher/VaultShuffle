import { ContentPage } from "@/components/ContentPage";

export default function PrivacyPage() {
  return (
    <ContentPage
      title="Privacy"
      intro="Vault Shuffle keeps the data model intentionally small: enough to import a Steam library, remember your backlog choices, and make the shuffle useful."
      panels={[
        {
          title: "Steam Sign-In",
          body: "Steam sign-in is handled by Steam OpenID. Vault Shuffle receives your SteamID64, display name, and avatar so it can recognise your account. Your Steam password is never shared with Vault Shuffle."
        },
        {
          title: "Library Data",
          body: "When you import from Steam, Vault Shuffle stores the game title, AppID, artwork links, playtime, last-played date, genre tags, rating data, and your own settings such as progress, library state, and notes."
        },
        {
          title: "Preview Mode",
          body: "You can look around without signing in. Preview games are stored in your browser only and are not synced to the hosted database."
        },
        {
          title: "Database And Hosting",
          body: "Signed-in app data is stored in Supabase and the site is hosted on Vercel. Server-side API keys are kept on the server and are not exposed to the browser."
        },
        {
          title: "Cookies And Sessions",
          body: "Vault Shuffle uses a session cookie so you do not have to sign in with Steam every time. Theme and preview preferences may also be saved in local browser storage."
        },
        {
          title: "Analytics",
          body: "The hosted site may use Vercel performance tooling to understand page speed and reliability. It is used to improve the project, not to sell personal data."
        },
        {
          title: "Deletion",
          body: "If you want your Vault Shuffle account or imported library data removed, contact the project owner and the stored Steam profile, games, settings, and notes can be deleted."
        },
        {
          title: "Steam Artwork",
          body: "Game names, Steam references, store links, ratings, and artwork come from public or third-party sources and remain owned by their respective rights holders."
        }
      ]}
    />
  );
}
