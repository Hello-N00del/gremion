// The pure half of the customer page's "Vertikale und Mitglieder" section
// (pilot creation path): which verticals the panel can name, the size caps of
// a member list, and the validate summary read back from a request's events.
// Shared by the page load, the actions and the page. The panel mutates nothing
// itself: seed_vertical and import_members are REQUESTS, and the host-side
// executor and the container's verbs are the lines that hold.
/**
 * The verticals the panel can name (a vertical is verticals/<id>/ in the
 * repository; the host's seed_vertical handler resolves the id). Start with
 * the one the pilot uses; more are added here and in nothing else.
 */
export const VERTICALS: readonly { id: string; label: string }[] = Object.freeze([{ id: 'stura', label: 'Studierendenvertretung (stura)' }])

/** Mirror of @gremion/provisioning's VERTICAL_ID (requests.ts); members.test.ts pins the two equal. */
export const VERTICAL_ID = /^[a-z][a-z0-9-]{0,62}$/
export const isKnownVertical = (v: string): boolean => VERTICAL_ID.test(v) && VERTICALS.some((x) => x.id === v)

/** Mirror of @gremion/provisioning's IMPORT_LIST_MAX_BYTES: the member list (UTF-8 bytes) of one request. */
export const IMPORT_LIST_MAX_BYTES = 1_048_576
/** The platform database's cap on the args of an import_members request (migration 0010: 1.5 MiB). */
export const IMPORT_PAYLOAD_MAX_BYTES = 1_572_864

/** One request event as the page draws it (the shape of server/modules EventLine; this file is shared with the client). */
export interface EventLike {
  level: string
  step: string
  message: string
}

export interface ImportCounts {
  created: number
  linkedExisting: number
  unchanged: number
  rejected: number
  accountsCreated: number
  invitesSent: number
}

export interface ImportSummary {
  status: string
  sha256: string
  counts: ImportCounts
}

// The handler's own line (infra/host/lib/executor/handlers/import_members.sh, import_report):
//   import validate: status=<s> sha256=<hex> created=N linked_existing=N unchanged=N rejected=N accounts_created=N invites_sent=N
export const SUMMARY_LINE =
  /^import validate: status=([a-z]+) sha256=([0-9a-f]{64}) created=(\d+) linked_existing=(\d+) unchanged=(\d+) rejected=(\d+) accounts_created=(\d+) invites_sent=(\d+)$/

/** The validate summary of a request's events, or null when there is none (or it is not exactly the handler's line). */
export function parseImportSummary(events: readonly EventLike[]): ImportSummary | null {
  for (const e of events) {
    const m = SUMMARY_LINE.exec(e.message.trim())
    if (!m) continue
    return {
      status: m[1]!,
      sha256: m[2]!,
      counts: { created: Number(m[3]), linkedExisting: Number(m[4]), unchanged: Number(m[5]), rejected: Number(m[6]), accountsCreated: Number(m[7]), invitesSent: Number(m[8]) },
    }
  }
  return null
}

/** Any token carrying an @ or its %40 form becomes [address]: events name rows by number, and this is the second net. */
export function redactAddresses(text: string): string {
  return text.replace(/\S*(?:@|%40)\S*/g, '[address]')
}