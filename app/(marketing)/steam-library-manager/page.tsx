import { MarketingPage } from "@/components/site/MarketingPage";
import { getMarketingMetadata, marketingPages } from "@/lib/marketing-pages";

const page = marketingPages[2];
export const metadata = getMarketingMetadata(page);

export default function SteamLibraryManagerPage() {
  return <MarketingPage page={page} />;
}
