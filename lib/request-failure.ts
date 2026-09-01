export class RequestFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  constructor(message: string, status: number, code = "unexpected_error", requestId?: string) {
    super(message); this.name = "RequestFailure"; this.status = status; this.code = code; this.requestId = requestId;
  }
}

export function isRetryableRequest(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const item = error as { code?: string; status?: number; name?: string };
  if (["rate_limited", "steam_rate_limited", "library_private", "steam_library_private", "library_empty", "library_unavailable"].includes(item.code ?? "")) return false;
  if (typeof item.status === "number") return item.status === 408 || item.status === 502 || item.status === 503 || item.status === 504;
  return item.name === "TypeError" || item.name === "TimeoutError";
}

export async function withTransientRetry<T>(work: () => Promise<T>, attempts = 3, wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await work(); }
    catch (error) {
      if (attempt + 1 >= attempts || !isRetryableRequest(error)) throw error;
      await wait(1200 * (attempt + 1));
    }
  }
}
