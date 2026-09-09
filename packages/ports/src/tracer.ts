// packages/ports/src/tracer.ts (@gremion/ports/tracer)
// P0.5 (design §3.2 Observability): the tracing/correlation PORT, no-op impl.
// P1 wires: hooks.server.ts ingress (read-or-mint x-correlation-id),
// internal-fetch.ts (forward header), worker tick + broker publish (carry id
// into EventEnvelope.correlationId). Full OTel/LGTM = defer-build (trigger:
// ≥3 services or a multi-hop incident). Propagation-point inventory lives in the
// product repo: docs/planning/2026-06-10-pillar1-p0.5-correlation-id-propagation-points.md
// P1 (D-P1-7): MOVED here from gremion-ui/src/lib/server/ports/tracer.ts so both the
// monolith and the newsletter leaf share ONE TracerPort; the old gremion-ui path is
// now a re-export shim. The T16 logTracer lands alongside noopTracer here.
//
// T16 (D-P1-8): logTracer — one valid-JSON line per span to stdout.
//   makeLogTracer(correlationId)  → TracerPort backed by JSON-line exporter.
//   readOrMintCorrelationId(raw)  → validates & returns or mints a fresh UUID.
//   TRACE_EXPORTER env: 'log' = logTracer, 'none' (default) = noopTracer.
import { randomUUID } from 'node:crypto'

export const CORRELATION_HEADER = 'x-correlation-id'

export interface SpanHandle {
  setAttribute(key: string, value: string | number | boolean): void
  /** end(error) marks the span failed; no-op impl ignores it. */
  end(error?: unknown): void
}

export interface TracerPort {
  startSpan(name: string, attributes?: Record<string, string | number | boolean>): SpanHandle
  /** The correlation id of the current execution context, if any. */
  currentCorrelationId(): string | null
}

export function newCorrelationId(): string {
  return randomUUID()
}

// ── UUID grammar validator (propagation rule 5) ────────────────────────────
// Accepts ONLY canonical RFC-4122 lower-case hex UUIDs.
// Max 36 chars enforced by the regex length (no trailing content allowed).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * P1 propagation rule 5: NEVER trust a client-supplied correlation id for auth.
 * The id is observability-only; a forged header must be discarded at ingress.
 *
 * Returns `raw` unchanged when it matches UUID grammar and is exactly 36 chars.
 * Mints a fresh UUID for null | undefined | empty | oversized | non-UUID input.
 */
export function readOrMintCorrelationId(raw: string | null | undefined): string {
  if (typeof raw === 'string' && raw.length === 36 && UUID_RE.test(raw)) {
    // F5: normalize to lower-case (canonical RFC-4122) so an upper-case inbound
    // UUID round-trips consistently with DB storage and equality checks.
    return raw.toLowerCase()
  }
  return randomUUID()
}

const inertSpan: SpanHandle = { setAttribute: () => undefined, end: () => undefined }

/** The P0.5 default: structurally complete, behaviorally silent. */
export const noopTracer: TracerPort = {
  startSpan: () => inertSpan,
  currentCorrelationId: () => null,
}

// ── logTracer (D-P1-8) ────────────────────────────────────────────────────────
//
// JSON-line-per-span exporter. Each span.end() emits one console.log() line
// that is valid JSON with at minimum: { name, durMs, correlationId }.
// Optional fields: error (string, from span.end(err)), attributes (from
// span.setAttribute()), and startTime (ISO-8601) for operator convenience.
//
// Usage:
//   const tracer = makeLogTracer(correlationId)
//   const span   = tracer.startSpan('newsletter.dispatch', { newsletterId: 1 })
//   …
//   span.end()   // or span.end(caughtError)
//
// TRACE_EXPORTER='log'  → use logTracer (set in the leaf's env).
// TRACE_EXPORTER='none' → use noopTracer (default in the monolith).

/**
 * Build a TracerPort that emits one valid-JSON line to stdout per span.
 * @param correlationId  The request/dispatch correlation id carried into every span.
 */
export function makeLogTracer(correlationId: string): TracerPort {
  return {
    currentCorrelationId: () => correlationId,

    startSpan(
      name: string,
      attributes: Record<string, string | number | boolean> = {},
    ): SpanHandle {
      const startMs = performance.now()
      const startTime = new Date().toISOString()
      // Mutable attribute bag — setAttribute() accumulates into this copy.
      const attrs: Record<string, string | number | boolean> = { ...attributes }

      return {
        setAttribute(key: string, value: string | number | boolean): void {
          attrs[key] = value
        },

        end(error?: unknown): void {
          const durMs = Math.round((performance.now() - startMs) * 100) / 100
          const record: Record<string, unknown> = {
            name,
            durMs,
            correlationId,
            startTime,
            ...attrs,
          }
          if (error !== undefined) {
            record['error'] =
              error instanceof Error ? error.message : String(error)
          }
          // One valid-JSON line (no trailing newline — console.log adds it).
          console.log(JSON.stringify(record))
        },
      }
    },
  }
}
