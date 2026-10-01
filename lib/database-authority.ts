/** Deployment chooses one authority. Errors never select the other database. */
export function isV2Authority(): boolean {
  const authority = process.env.VAULT_DATABASE_AUTHORITY ?? "legacy";
  if (authority !== "legacy" && authority !== "v2") throw new Error("Invalid database authority configuration.");
  return authority === "v2";
}
