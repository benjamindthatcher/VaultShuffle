import { ContentPage } from "@/components/ContentPage";

export default function AboutPage() {
  return (
    <ContentPage
      title="A calmer way to face the backlog."
      intro="Vault Shuffle began as a practical game backlog tracker, then grew into a more focused idea: help people actually choose and play something."
      panels={[
        {
          title: "The Idea",
          body: "Most game libraries are good at collecting titles and bad at helping you decide. Vault Shuffle keeps the collection, but puts the decision front and centre."
        },
        {
          title: "The Direction",
          body: "The app is now moving into a real hosted shape with Next.js, Supabase, Steam sign-in, Steam search, artwork, smart filters, and a polished blue-purple interface."
        },
        {
          title: "The Name",
          body: "Your library is the vault. Shuffle is the action. Together, Vault Shuffle is about letting one good choice step forward."
        }
      ]}
    />
  );
}
