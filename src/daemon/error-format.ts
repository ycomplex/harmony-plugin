// B-844: daemon catch sites used to render a caught failure through the bare
// `err instanceof Error ? err.message : String(err)` pattern. That pattern discards exactly the
// information a human needs to act on a daemon failure:
//
//   - A raw fetch() network rejection (DNS/ECONNRESET/etc) is a TypeError whose message is just
//     "fetch failed" — the real cause lives one level down, in `.cause`, and `.message` alone
//     never shows it.
//   - A structured HTTP-shaped failure (e.g. the token-exchange error thrown by src/auth.ts) had
//     its endpoint/status/body flattened into a single message string upstream, or — worse — a
//     non-Error rejection (a plain PostgREST/edge-function JSON error body) went through
//     `String(err)` and produced the famously useless "[object Object]".
//
// formatDaemonError is the one place that knows how to render each shape usefully. Call sites
// pass it the caught value (and, where known, the endpoint) instead of re-deriving a message.

/** A structured HTTP-shaped error — the shape thrown by src/auth.ts's TokenExchangeError, or
 *  anything else that carries endpoint + status + body. Duck-typed rather than imported so this
 *  module has no dependency on auth.ts's concrete class. */
interface HttpShapedError {
  endpoint?: string;
  status: number;
  body: unknown;
}

function isHttpShapedError(err: unknown): err is HttpShapedError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as { status: unknown }).status === 'number' &&
    'body' in err
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    // Circular refs etc — fall back to String() rather than throw out of a formatter.
    return String(value);
  }
}

/** Render the innermost `.cause` in a cause chain — real Node undici fetch failures nest a couple
 *  of levels deep (TypeError -> cause: Error -> cause: { code, errno, ... }). */
function describeCause(cause: unknown, depth = 0): string {
  if (depth > 5) return safeStringify(cause); // guard against a pathological/circular chain
  if (cause instanceof Error) {
    if ('cause' in cause && cause.cause !== undefined) {
      return `${cause.name}: ${cause.message} <- ${describeCause(cause.cause, depth + 1)}`;
    }
    return `${cause.name}: ${cause.message}`;
  }
  if (typeof cause === 'object' && cause !== null) {
    const code = 'code' in cause ? (cause as { code: unknown }).code : undefined;
    const errno = 'errno' in cause ? (cause as { errno: unknown }).errno : undefined;
    const parts: string[] = [];
    if (code !== undefined) parts.push(`code=${String(code)}`);
    if (errno !== undefined) parts.push(`errno=${String(errno)}`);
    if (parts.length > 0) return parts.join(' ');
    return safeStringify(cause);
  }
  return String(cause);
}

/** Format a caught daemon failure into a message that names the real cause, instead of a bare
 *  "TypeError: fetch failed" or "[object Object]".
 *
 *  IMPORTANT (secret-redaction guardrail): only ever pass this the caught response/error value —
 *  NEVER the outgoing request, an Authorization header, or a bearer token. A failed
 *  /functions/v1/auth-token response body is a generic edge-function error shape
 *  ({message, code, details, hint}), not the credential itself, so this holds by construction as
 *  long as callers never pass request data in. */
export function formatDaemonError(err: unknown, opts?: { endpoint?: string }): string {
  // Rule 1: a structured HTTP-shaped error (endpoint + status + body) — render all three.
  if (isHttpShapedError(err)) {
    const endpoint = err.endpoint ?? opts?.endpoint ?? '(unknown endpoint)';
    return `HTTP ${err.status} from ${endpoint}: ${safeStringify(err.body)}`;
  }

  // Rule 2: an Error with a .cause chain — walk it and render the innermost cause alongside the
  // top-level message. This is the raw fetch() network-failure case (TypeError: fetch failed).
  if (err instanceof Error) {
    if ('cause' in err && err.cause !== undefined) {
      const endpointPrefix = opts?.endpoint ? `[${opts.endpoint}] ` : '';
      return `${endpointPrefix}${err.name}: ${err.message} (cause: ${describeCause(err.cause)})`;
    }
    const endpointPrefix = opts?.endpoint ? `[${opts.endpoint}] ` : '';
    return `${endpointPrefix}${err.name}: ${err.message}`;
  }

  // Rule 3: a non-Error rejection (a plain object rejection body, e.g. a PostgREST/edge-function
  // JSON error shape) — JSON.stringify it rather than let bare string coercion produce
  // "[object Object]". Fall back to String() only if stringification itself throws.
  return safeStringify(err);
}
