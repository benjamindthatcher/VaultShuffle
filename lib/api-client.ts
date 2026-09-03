"use client";
import { announceCooldown, CooldownError, SteamLibraryPrivateError } from "./cooldown";
import { diagnosticId } from "./diagnostics";
import { diagnosticRequestHeaders } from "./posthog-client";
import { RequestFailure } from "./request-failure";

export async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const operationId = diagnosticId(new Headers(options.headers).get("X-Vault-Operation-Id")) ?? crypto.randomUUID();
  const requestHeaders = new Headers(options.headers);
  requestHeaders.set("Content-Type", "application/json");
  for (const [key, value] of Object.entries(diagnosticRequestHeaders(operationId))) requestHeaders.set(key, value);

  // Failures are not reported from here. The same failure already arrives as a
  // server_error carrying this request id, and as $exception if it reached the
  // browser as one - client_request_failed was a third copy of one event.
  const response = await fetch(path, { ...options, headers: requestHeaders });
  const requestId = diagnosticId(response.headers.get("X-Request-Id"));
  const payload = await response.json().catch(() => { throw new RequestFailure("The server returned an incomplete response. Please try again.", 502, "invalid_request", requestId); });
  if (!payload || typeof payload !== "object") throw new RequestFailure("The server returned an incomplete response. Please try again.", 502, "invalid_request", requestId);
  if (!response.ok) {
    const cooldown = announceCooldown(response, payload);
    if (cooldown) throw Object.assign(new CooldownError(cooldown.retryAfterSeconds, cooldown.message, payload.code), { requestId, status: response.status });
    if (["steam_library_private", "library_private", "library_unavailable"].includes(payload.code)) {
      throw Object.assign(new SteamLibraryPrivateError(payload.error || "Steam did not share a games list."), { code: payload.code, requestId, status: response.status });
    }
    throw new RequestFailure(response.status === 401 ? "unauthorized" : payload.error || "Request failed.", response.status, payload.code, requestId);
  }
  return payload as T;
}
