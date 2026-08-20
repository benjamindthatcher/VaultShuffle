import { permanentRedirect } from "next/navigation";

export default function LegacyStatsPage() {
  permanentRedirect("/dashboard");
}
