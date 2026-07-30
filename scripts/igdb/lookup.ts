import { IgdbDurationProvider } from "../../supabase/functions/_shared/igdb-duration-provider.ts";

const appId = Number(argument("--steam-app-id"));
if (!Number.isSafeInteger(appId) || appId <= 0) fail("Usage: npm run igdb:lookup -- --steam-app-id <positive AppID>");
const title = argument("--title") ?? null;
const releaseYearValue = argument("--release-year");
const releaseYear = releaseYearValue ? Number(releaseYearValue) : null;
if (releaseYearValue && (!Number.isInteger(releaseYear) || Number(releaseYear) < 1950 || Number(releaseYear) > 2100)) {
  fail("--release-year must be a four-digit year.");
}
const clientId = process.env.IGDB_CLIENT_ID;
const clientSecret = process.env.IGDB_CLIENT_SECRET;
if (!clientId || !clientSecret) fail("Missing local IGDB credentials. Configure a gitignored environment file first.");

try {
  const result = await new IgdbDurationProvider(clientId, clientSecret).findBySteamAppId(appId, {
    title,
    releaseYear
  });
  console.log(`Steam AppID: ${result.steamAppId}`);
  console.log(`Status: ${result.status}`);
  console.log(`IGDB game ID: ${result.providerGameId ?? "Not available"}`);
  console.log(`Main Story: ${format(result.mainStoryMinutes)}`);
  console.log(`Main + Extras: ${format(result.mainExtraMinutes)}`);
  console.log(`Completionist: ${format(result.completionistMinutes)}`);
  console.log(`Submission count: ${result.submissionCount ?? "Not available"}`);
} catch {
  fail("IGDB lookup failed. Check the function secrets and provider availability.");
}

function argument(name: string) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function format(value: number | null) { return value ? `${value} minutes` : "Not available"; }
function fail(message: string): never { console.error(message); process.exit(1); }
