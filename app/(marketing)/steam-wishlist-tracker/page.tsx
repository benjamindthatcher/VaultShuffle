import { MarketingPage } from "@/components/site/MarketingPage";
import { getMarketingMetadata, marketingPages } from "@/lib/marketing-pages";

const page = marketingPages[3];
export const metadata = getMarketingMetadata(page);

export default function SteamWishlistTrackerPage() {
  return <MarketingPage page={page} />;
}
