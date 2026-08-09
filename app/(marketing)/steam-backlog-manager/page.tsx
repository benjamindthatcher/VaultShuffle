import { MarketingPage } from "@/components/site/MarketingPage";
import { getMarketingMetadata, marketingPages } from "@/lib/marketing-pages";

const page = marketingPages[1];
export const metadata = getMarketingMetadata(page);

export default function SteamBacklogManagerPage() {
  return <MarketingPage page={page} />;
}
