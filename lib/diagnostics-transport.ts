import { diagnosticId, safeDiagnosticProperties, type DiagnosticProperties } from "./diagnostics.ts";

export type DiagnosticEvent = { event: "server_operation" | "server_error"; properties: DiagnosticProperties; timestamp: string; uuid: string };
export type DiagnosticDelivery = "delivered" | "disabled" | "unconfigured" | "failed";

/** One bounded, awaited delivery. No DB writes, recursive logging, retry queue or SDK singleton. */
export async function deliverDiagnostics(input: {
  events: DiagnosticEvent[]; enabled: boolean; person?: string; replay?: string;
  token?: string; host?: string; environment?: string; release?: string;
}, send: typeof fetch = fetch): Promise<DiagnosticDelivery> {
  if (!input.enabled || !input.events.length) return "disabled";
  if (!input.token) return "unconfigured";
  // Never allow a misconfigured host to send telemetry to an arbitrary origin.
  const host = input.host?.includes("us.") ? "https://us.i.posthog.com" : "https://eu.i.posthog.com";
  const person = diagnosticId(input.person);
  const replay = diagnosticId(input.replay);
  try {
    const response = await send(`${host}/batch/`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(3500),
      body: JSON.stringify({ api_key: input.token, batch: input.events.slice(0, 20).map((item) => ({
        event: item.event, uuid: item.uuid, timestamp: item.timestamp,
        properties: { ...safeDiagnosticProperties(item.properties), distinct_id: person ?? item.properties.request_id ?? item.uuid,
          ...(replay ? { $session_id: replay } : {}), $process_person_profile: false, $geoip_disable: true,
          diagnostics_version: 1, source: "server", environment: input.environment === "production" ? "production" : "preview",
          ...(input.release && /^[a-f0-9]{7,40}$/i.test(input.release) ? { release: input.release } : {}),
        },
      })) }),
    });
    return response.ok ? "delivered" : "failed";
  } catch { return "failed"; }
}
