// services/votes/src/helios/helios-client.ts
// Leaf-local THIN Helios read client — only the read surface the /votes
// aggregation needs (getElection), plus the lifecycle derivation and the
// "tracked-but-unreachable" classification the settle loop relies on. Duplicated
// from the read half of gremion-ui/src/lib/server/elections/helios-client.ts (the
// leaf is a separate process and cannot import the kernel $lib). The Helios ADMIN
// surface (create/freeze/setQuestions/bulkUploadVoters) is NOT here — it stays on
// the kernel in-process client by design (this leaf is read/aggregate only).
//
// The Helios base URL comes from the leaf's own HELIOS_URL env (mirrors the files
// leaf reading NEXTCLOUD_URL); per-tenant Helios routing is a cutover concern.

export class HeliosUnavailableError extends Error {
  constructor(
    message: string,
    /** HTTP status when the request reached Helios; null on a network failure. */
    readonly status: number | null,
  ) {
    super(message)
    this.name = 'HeliosUnavailableError'
  }
}

/** Type guard: a "tracked-but-unreachable" failure the settle loop degrades on
 *  (rather than a real bug). Covers HeliosUnavailableError + a bare network
 *  TypeError (fetch rejects with a TypeError when the host can't be reached). */
export function isHeliosUnavailable(e: unknown): boolean {
  if (e instanceof HeliosUnavailableError) return true
  return e instanceof TypeError
}

export interface HeliosElection {
  uuid: string
  short_name: string
  name: string
  description: string
  voting_starts_at: string | null
  voting_ends_at: string | null
  frozen_at: string | null
  archived_at: string | null
  num_cast_votes: number
  result: unknown | null
  result_proof: unknown | null
}

export type ElectionLifecycle = 'draft' | 'open' | 'closed'

export function deriveLifecycle(e: HeliosElection): ElectionLifecycle {
  if (e.frozen_at === null) return 'draft'
  if (e.voting_ends_at !== null && new Date(e.voting_ends_at) > new Date()) return 'open'
  return 'closed'
}

function heliosBase(): string {
  return (process.env.HELIOS_URL ?? 'http://helios:8000').replace(/\/$/, '')
}

async function heliosFetch<T>(path: string): Promise<T> {
  const base = heliosBase()
  let res: Response
  try {
    res = await fetch(`${base}${path}`)
  } catch (e) {
    // fetch rejects (TypeError "fetch failed") when Helios is unreachable —
    // connection refused, DNS failure, TLS error. Surface as "unavailable" so
    // the settle loop degrades the row instead of dropping it.
    throw new HeliosUnavailableError(
      `Helios ${path} unreachable: ${e instanceof Error ? e.message : String(e)}`,
      null,
    )
  }
  if (!res.ok) {
    // 404 (election not on this Helios instance) and 5xx (Helios down / not
    // ready) are reachability problems for a tracked row, not real bugs.
    if (res.status === 404 || res.status >= 500) {
      throw new HeliosUnavailableError(`Helios ${path} → ${res.status}`, res.status)
    }
    throw new Error(`Helios ${path} → ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const HeliosClient = {
  getElection(uuid: string): Promise<HeliosElection> {
    return heliosFetch<HeliosElection>(`/helios/elections/${uuid}`)
  },
}
