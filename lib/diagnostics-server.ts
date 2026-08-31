import "server-only";
import { after } from "next/server";
import { headers } from "next/headers";
import { diagnosticConsent, diagnosticFailure, diagnosticId, diagnosticRoute, safeDiagnosticProperties } from "./diagnostics";
import { deliverDiagnostics, type DiagnosticEvent } from "./diagnostics-transport";

export class RequestDiagnostics {
  readonly requestId: string;
  private readonly started = Date.now();
  private stageStarted = Date.now();
  private currentStage = "request";
  private events: DiagnosticEvent[] = [];
  private scheduled = false;
  private accountId?: string;
  private accountType?: string;
  constructor(private readonly requestHeaders: Headers, private readonly operation: string, private readonly route: string, private readonly method: string, requestId?: string) {
    this.requestId = diagnosticId(requestId) ?? diagnosticId(requestHeaders.get("x-vault-request-id")) ?? crypto.randomUUID();
  }
  stage(stage: string) { this.currentStage = stage; this.stageStarted = Date.now(); }
  account(id: string, type: string) { this.accountId = diagnosticId(id); this.accountType = type; }
  event(outcome: "started" | "succeeded" | "failed" | "deferred" | "warning", details: Record<string, unknown> = {}, error?: unknown) {
    const properties = safeDiagnosticProperties({ ...details, ...(error ? diagnosticFailure(error) : {}),
      operation: this.operation, stage: this.currentStage, outcome, route: this.route, method: this.method,
      request_id: this.requestId, operation_id: this.requestHeaders.get("x-vault-operation-id"),
      account_id: this.accountId, account_type: this.accountType,
      duration_ms: Date.now() - this.started, stage_duration_ms: Date.now() - this.stageStarted,
    });
    const event: DiagnosticEvent = { event: outcome === "failed" || outcome === "warning" ? "server_error" : "server_operation", properties, timestamp: new Date().toISOString(), uuid: crypto.randomUUID() };
    const log = JSON.stringify({ level: outcome === "failed" ? "error" : outcome === "warning" ? "warning" : "info", event: event.event, ...properties });
    if (outcome === "failed") console.error(log); else if (outcome === "warning") console.warn(log); else console.info(log);
    if (this.events.length < 20) this.events.push(event);
    if (!this.scheduled) {
      this.scheduled = true;
      try { after(() => this.flush()); } catch { /* Outside Next (e.g. tests): console diagnostics already written. */ }
    }
  }
  response<T extends Response>(response: T): T { response.headers.set("X-Request-Id", this.requestId); return response; }
  async flush() {
    const events = this.events.splice(0);
    const consent = diagnosticConsent(this.requestHeaders);
    const result = await deliverDiagnostics({ events, enabled: consent.enabled, person: consent.person, replay: consent.replay,
      token: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN, host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV, release: process.env.VERCEL_GIT_COMMIT_SHA,
    });
    if (result === "failed" || result === "unconfigured") console.warn(JSON.stringify({ level: "warning", event: "diagnostics_delivery_failed", reason: result, request_id: this.requestId }));
  }
}

export function requestDiagnostics(request: Request, operation: string) {
  return new RequestDiagnostics(request.headers, operation, diagnosticRoute(new URL(request.url).pathname), request.method);
}

/** Shared handled-error path, including routes without custom milestones. */
export function reportApiFailure(error: unknown, status: number, requestId: string, operation = "api_request", stage = "request", warning = false) {
  try {
    after(async () => {
      try {
        const context = await headers();
        const diagnostics = new RequestDiagnostics(new Headers(context), operation, context.get("x-vault-route") ?? "/api/:id", context.get("x-vault-method") ?? "GET", requestId);
        diagnostics.stage(stage);
        diagnostics.event(warning ? "warning" : status === 429 ? "deferred" : "failed", { status }, error);
        await diagnostics.flush();
      } catch {
        console.error(JSON.stringify({ event: "server_error", request_id: requestId, status, ...diagnosticFailure(error) }));
      }
    });
  } catch {
    console.error(JSON.stringify({ event: "server_error", request_id: requestId, status, ...diagnosticFailure(error) }));
  }
}

export function reportServiceWarning(error: unknown, operation: string, stage: string) {
  reportApiFailure(error, 503, crypto.randomUUID(), operation, stage, true);
}
