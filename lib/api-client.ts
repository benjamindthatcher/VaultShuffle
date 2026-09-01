"use client";
import { announceCooldown, CooldownError, SteamLibraryPrivateError } from "./cooldown";
import { diagnosticFailure, diagnosticId, diagnosticRoute } from "./diagnostics";
import { captureProductEvent, diagnosticRequestHeaders } from "./posthog-client";
import { RequestFailure } from "./request-failure";

export async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const operationId = diagnosticId(new Headers(options.headers).get("X-Vault-Operation-Id")) ?? crypto.randomUUID();
  const requestHeaders = new Headers(options.headers);
  requestHeaders.set("Content-Type", "application/json");
  for (const [key, value] of Object.entries(diagnosticRequestHeaders(operationId))) requestHeaders.set(key, value);
  let response: Response | undefined;
  try {
    response = await fetch(path, { ...options, headers: requestHeaders });
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
  } catch (error) {
    captureProductEvent("client_request_failed", {
      route: diagnosticRoute(path), operation_id: operationId, request_id: diagnosticId(response?.headers.get("X-Request-Id")),
      status: response?.status ?? 0,
      ...diagnosticFailure(error),
    });
    throw error;
  }
}
