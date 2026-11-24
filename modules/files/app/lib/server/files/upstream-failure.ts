// What a caller of /api/files may learn about a failed Nextcloud call.
//
// The upstream error text is "Nextcloud <METHOD> <dav path> → <status>: <body>". The
// DAV path carries the user's Nextcloud id and the server layout, so it never goes
// into a response; the caller gets a status and a plain German sentence, and the
// full detail goes to the server log, where an operator can find it.
import { error } from '@sveltejs/kit'

export interface UpstreamFailure {
  status: 403 | 404 | 502
  message: string
}

/** Map an upstream failure to the status and message the caller may see. Logs the
 *  detail under `tag` (server side only). */
export function describeUpstreamFailure(err: unknown, tag: string, context: Record<string, unknown> = {}): UpstreamFailure {
  const detail = err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown upstream error'
  console.error(tag, { ...context, detail })
  const upstream = /→ (40[34]):/.exec(detail)?.[1]
  if (upstream === '404') return { status: 404, message: 'Nicht gefunden.' }
  if (upstream === '403') return { status: 403, message: 'Kein Zugriff auf diesen Ordner oder diese Datei.' }
  return { status: 502, message: 'Der Dokumentenspeicher ist gerade nicht erreichbar.' }
}

/** Write paths and the edit token keep their contract (any upstream failure is a 502):
 *  throw it with the fixed German message instead of the upstream text. */
export function throwBadGateway(err: unknown, tag: string, context: Record<string, unknown> = {}): never {
  describeUpstreamFailure(err, tag, context)
  throw error(502, 'Der Dokumentenspeicher ist gerade nicht erreichbar.')
}
