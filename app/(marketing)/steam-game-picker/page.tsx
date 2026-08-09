import { MarketingPage } from "@/components/site/MarketingPage";
import { getMarketingMetadata, marketingPages } from "@/lib/marketing-pages";

const page = marketingPages[0];
export const metadata = getMarketingMetadata(page);

export default function SteamGamePickerPage() {
  return <MarketingPage page={page} />;
}
