import type { Instrumentation } from "next";

/** Catches server render/route/action errors not handled by jsonError. */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const { RequestDiagnostics } = await import("./lib/diagnostics-server");
  const requestHeaders = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") requestHeaders.set(key, value);
  }
  const diagnostics = new RequestDiagnostics(requestHeaders, "uncaught_request", context.routePath, request.method);
  diagnostics.event("failed", { status: 500 }, error);
  await diagnostics.flush();
};
