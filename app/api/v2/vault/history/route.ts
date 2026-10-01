import { v2Read, v2Write } from "@/lib/v2/http/request";
export const runtime = "nodejs";
export async function GET() { return v2Read((services, principal) => services.vault.history(principal)); }
export async function DELETE(request: Request) { return v2Write(request, (services, principal) => services.vault.clearHistory(principal)); }
