import { redirect } from "next/navigation";

// Keep old bookmarks harmless now that profile URL sign-in restores the account.
export default function RetiredSecureProfilePage() {
  redirect("/dashboard");
}
