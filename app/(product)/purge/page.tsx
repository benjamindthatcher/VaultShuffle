import { redirect } from "next/navigation";

/**
 * Purge is gone; the Library does its job now.
 *
 * A redirect rather than a deletion because the page was linked from the Vault,
 * from the dashboard and from wherever people bookmarked it, and a 404 is a poor
 * answer to "the thing I used is missing". The slept shelf is where its work
 * ended up, so that is where this lands.
 */
export default function PurgeMovedPage() {
  redirect("/library?tab=slept");
}
