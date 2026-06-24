import { ContentPage } from "@/components/ContentPage";

export default function TermsPage() {
  return (
    <ContentPage
      title="Terms"
      intro="Plain terms for the current hosted-project build."
      panels={[
        {
          title: "Use",
          body: "Vault Shuffle is a backlog tracker and game picker. It is provided as a project build while the product is still evolving."
        },
        {
          title: "Game Data And Artwork",
          body: "Game names, artwork, Steam references, and store links belong to their respective owners. Vault Shuffle is not affiliated with Steam or game publishers."
        },
        {
          title: "No Guarantees",
          body: "Back up anything important before experimenting with migrations or database changes."
        }
      ]}
    />
  );
}
