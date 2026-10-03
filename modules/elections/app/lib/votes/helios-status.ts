// gremion-ui/src/lib/votes/helios-status.ts
// D4 (design v11): ONE reachability source for the /votes head pill.
//
// The pill used to be a hardcoded `pill-success · Helios verbunden` while the
// degraded cards below said "Helios derzeit nicht erreichbar" — a contradiction.
// Both now derive from the SAME probe: the VotesBackendPort.listVotes result
// (`degradedUuids` = tracked Helios elections whose ballot could not be reached;
// `pollError` = the backend list itself failed upstream).
//
// Tone rule (#343 R2): warn = Einschränkung/Aufgabe, success = erledigt/ok,
// danger nur echte Fehler — an unreachable satellite is an Einschränkung, not a
// hard failure (the page still renders), so both degraded states are warn.
// Glyphs follow the pill-icon contract (CR-3): success→check · warn→clock.
//
// Pure + client-safe (no server imports) so the load fn stays thin and the
// derivation is unit-testable.

import type { VoteItem } from './types'

export interface HeliosStatus {
  kind: 'connected' | 'unreachable' | 'degraded'
  tone: 'success' | 'warn'
  /** Disambiguating glyph per the pill-icon contract (success→check · warn→clock). */
  icon: 'check' | 'clock'
  label: string
}

/**
 * Derive the head-pill state from the votes-backend probe result.
 *
 * - no `pollError`, no degraded rows → success „Helios verbunden“
 * - `pollError` (the backend list itself failed) → warn „Helios nicht erreichbar“
 * - some degraded rows (partial: individual ballots unreachable) → warn
 *   „Helios eingeschränkt“
 *
 * A full outage outranks the partial state when both apply.
 */
export function deriveHeliosStatus(pollError: string | null, degradedCount: number): HeliosStatus {
  if (pollError !== null) {
    return { kind: 'unreachable', tone: 'warn', icon: 'clock', label: 'Helios nicht erreichbar' }
  }
  if (degradedCount > 0) {
    return { kind: 'degraded', tone: 'warn', icon: 'clock', label: 'Helios eingeschränkt' }
  }
  return { kind: 'connected', tone: 'success', icon: 'check', label: 'Helios verbunden' }
}

/**
 * D4 dedupe: the combined /votes list must never carry the same helios_uuid
 * twice. Filters the degraded uuid set against the already-hydrated items
 * (dedupe key: the uuid behind the `helios:` id namespace; the hydrated row
 * wins) and drops repeats within the degraded set itself. Order is preserved.
 */
export function dedupeDegradedUuids(
  hydrated: readonly VoteItem[],
  degradedUuids: readonly string[],
): string[] {
  const hydratedUuids = new Set(
    hydrated.filter((v) => v.kind === 'helios').map((v) => v.id.replace(/^helios:/, '')),
  )
  const seen = new Set<string>()
  const out: string[] = []
  for (const uuid of degradedUuids) {
    if (hydratedUuids.has(uuid) || seen.has(uuid)) continue
    seen.add(uuid)
    out.push(uuid)
  }
  return out
}
