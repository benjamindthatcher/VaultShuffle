import { redirect } from "next/navigation";
import { Dashboard } from "@/components/Dashboard";
import { getCurrentSession } from "@/lib/auth";

export default async function AppPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");

  return (
    <>
      <link rel="stylesheet" href="/styles.css" />
      <Dashboard />
    </>
  );
}
