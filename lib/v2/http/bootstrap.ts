import type { BootstrapRepository } from "../repositories/bootstrap-core.ts";
import type { SessionRepository } from "../repositories/session-core.ts";
import { authenticatedRead } from "./read-response.ts";

type Services = Readonly<{ sessions: Pick<SessionRepository, "resolveCookie">; bootstrap: Pick<BootstrapRepository, "read"> }>;

/** The cookie resolver is the sole source of the account principal. */
export async function bootstrapResponse(token: string | undefined, secret: string | undefined, services: () => Promise<Services>): Promise<Response> {
  return authenticatedRead(token, secret, services, (runtime, principal) => runtime.bootstrap.read(principal));
}
