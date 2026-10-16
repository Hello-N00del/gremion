// packages/nats-auth/src/flows.ts (@gremion/nats-auth)
//
// THE NATS identity map and flow matrix (TASK-024 Q3, Q14). One NATS user per
// (tenant, catalogue module) that talks to the broker, plus the kernel; this
// table says which JetStream streams each of them publishes and consumes, and
// the permissions in ./permissions.ts are derived from it and nothing else.
//
// Keyed by CATALOGUE id (the modules/<id> directory name), not by stream or
// context code: `publishing` owns NEWSLETTER (TASK-043 drops its publishing ->
// newsletter alias; the identity is `publishing`). The kernel is not a
// catalogue module but a user of its own: the audit consumers run in-process
// in gremion-ui under this identity (TASK-205 moves them), and the org-unit
// relay publishes as it.
//
// The guards in matrixViolations() are what keep this table honest against
// the rest of the tree: the STREAMS topology (@gremion/ports/broker), the
// contracts registry, and the modules/ directory.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { STREAMS } from '@gremion/ports/broker'

export type StreamName = keyof typeof STREAMS

export interface ModuleFlow {
  /** Streams this identity publishes into. Exactly one publisher per stream. */
  readonly publishes: readonly string[]
  /** Streams this identity reads with a consumer. */
  readonly consumes: readonly string[]
}

/** The kernel's identity. Not a modules/* directory; always provisioned. */
export const KERNEL = 'kernel'

/** Section 4.3 flows, measured 2026-09-28:
 *  F1 kernel -> ORGUNIT -> finance; F2 publishing -> NEWSLETTER -> kernel;
 *  F3 content -> CONTENT -> kernel; F4 calendar -> CALENDAR -> kernel. */
export const FLOWS: Readonly<Record<string, ModuleFlow>> = Object.freeze({
  kernel: { publishes: ['ORGUNIT'], consumes: ['NEWSLETTER', 'CONTENT', 'CALENDAR'] },
  publishing: { publishes: ['NEWSLETTER'], consumes: [] },
  content: { publishes: ['CONTENT'], consumes: [] },
  calendar: { publishes: ['CALENDAR'], consumes: [] },
  finance: { publishes: [], consumes: ['ORGUNIT'] },
})

/** System streams a tenant account holds BESIDE the flow streams (TASK-079 Q2, G5). They are not
 *  in FLOWS and not in the ports STREAMS topology: no module owns or consumes them.
 *  DLQ: the tenant's dead-letter stream. Consumers publish their poison messages to
 *  gremion.<t>.dlq.<module>.<consumer> (the one publish grant every flow module key holds beyond
 *  its own streams), and the server's MAX_DELIVERIES advisory -- the backstop for a consumer that
 *  crashed on its last delivery -- is captured into it. Created by the tenant `admin` only
 *  (a module key cannot create streams or read advisories). Same limits as every flow stream
 *  (@gremion/ports ensureStream: 7 days, dedup 2 min), so a dead letter is replayable for 7 days. */
export const SYSTEM_STREAMS: Readonly<Record<string, { name: string; subjects: string[] }>> = Object.freeze({
  DLQ: { name: 'DLQ', subjects: ['gremion.*.dlq.>', '$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>'] },
})

/** The one dead-letter publish grant of a flow module key: gremion.<t>.dlq.<module>.> */
export const dlqGrantFor = (tenant: string, module: string): string => `gremion.${tenant}.dlq.${module}.>`

/** Catalogue modules that do not touch the broker (no NATS_URL under
 *  modules/<id>/src, measured 2026-09-28). They get NO user. elections and
 *  handover arrive with TASK-021 and are listed ahead of it so its merge does
 *  not trip the directory scan. A module that starts using NATS moves from
 *  here into FLOWS. */
export const NO_BROKER = Object.freeze({
  asOf: '2026-09-28',
  ids: Object.freeze(['board', 'files', 'messaging', 'vault', 'votes', 'elections', 'handover']),
})

/** contracts/registry.json owners are context codes, not catalogue ids. */
export const OWNER_TO_MODULE: Readonly<Record<string, string>> = Object.freeze({
  cal: 'calendar',
  pub: 'content',
})

export interface NoStreamEntry {
  readonly owner: string
  /** The subject segment after gremion.<tenant>. */
  readonly segment: string
  /** The task that gives it a stream (and removes this entry). */
  readonly until: string
}

/** Registry addresses that have no stream YET. Dated: an entry whose segment
 *  a stream starts capturing, or that no address uses any more, is stale and
 *  fails the matrix. */
export const NO_STREAM = Object.freeze({
  asOf: '2026-09-28',
  entries: Object.freeze([
    { owner: 'gov', segment: 'gov', until: 'TASK-084' },
    // TASK-079 built the library, not this event: the provisioning-completed event is TASK-080's
    // (the kernel API hosts the relay, TRD-407), so the entry is re-dated (TASK-079 Q12).
    { owner: 'gov', segment: 'provisioning', until: 'TASK-080' },
  ] as NoStreamEntry[]),
})

export interface RegistryAddress {
  readonly owner: string
  readonly spec: string
  /** e.g. gremion.{tenantId}.calendar.event.created */
  readonly address: string
}

/** Every asyncapi channel address of every registered spec, with its owner. */
export function loadRegistryAddresses(repoRoot: string): RegistryAddress[] {
  const registry = JSON.parse(readFileSync(path.join(repoRoot, 'contracts/registry.json'), 'utf8')) as {
    specs: { name: string; type: string; file: string; owner: string }[]
  }
  const out: RegistryAddress[] = []
  for (const spec of registry.specs) {
    if (spec.type !== 'asyncapi') continue
    const doc = JSON.parse(readFileSync(path.join(repoRoot, spec.file), 'utf8')) as {
      channels?: Record<string, { address?: string | null }>
    }
    for (const [key, ch] of Object.entries(doc.channels ?? {})) {
      out.push({ owner: spec.owner, spec: spec.name, address: ch.address ?? key })
    }
  }
  return out
}

export interface MatrixInput {
  flows: Record<string, ModuleFlow>
  noBroker: string[]
  streams: Record<string, { name: string; subjects: string[] }>
  /** SYSTEM_STREAMS: filters that must stay disjoint from every flow stream. */
  systemStreams?: Record<string, { name: string; subjects: string[] }>
  registry: RegistryAddress[]
  ownerToModule: Record<string, string>
  noStream: NoStreamEntry[]
  /** modules/* directory names (the catalogue ids). */
  moduleIds: string[]
}

/** A concrete subject for an address template: {x} placeholders become a
 *  literal token so the pattern check below is about the fixed tokens. */
const concrete = (address: string): string => address.replace(/\{[^}]+\}/g, 'x')

const tokens = (s: string): string[] => s.split('.')

/** Does pattern `p` match the concrete subject `s` ('*' one token, '>' one or more, last). */
export function patternMatches(p: string, s: string): boolean {
  const pt = tokens(p)
  const st = tokens(s)
  for (let i = 0; i < pt.length; i++) {
    if (pt[i] === '>') return i === pt.length - 1 && st.length > i
    if (i >= st.length) return false
    if (pt[i] !== '*' && pt[i] !== st[i]) return false
  }
  return pt.length === st.length
}

/** Can some subject match both patterns? */
export function patternsOverlap(a: string, b: string): boolean {
  const at = tokens(a)
  const bt = tokens(b)
  const n = Math.max(at.length, bt.length)
  for (let i = 0; i < n; i++) {
    const x = at[i]
    const y = bt[i]
    if (x === '>' || y === '>') return x !== undefined && y !== undefined
    if (x === undefined || y === undefined) return false
    if (x !== '*' && y !== '*' && x !== y) return false
  }
  return true
}

const segmentOf = (address: string): string | undefined => tokens(address)[2]

export function matrixViolations(input: MatrixInput): string[] {
  const out: string[] = []
  const { flows, streams } = input
  const streamNames = Object.keys(streams)

  // Every FLOWS entry names known streams only.
  for (const [id, f] of Object.entries(flows)) {
    for (const s of [...f.publishes, ...f.consumes]) {
      if (!streams[s]) out.push(`flow ${id} names unknown stream ${s}`)
    }
  }
  // Exactly one publisher per stream.
  for (const s of streamNames) {
    const pubs = Object.entries(flows).filter(([, f]) => f.publishes.includes(s)).map(([id]) => id)
    if (pubs.length !== 1) out.push(`stream ${s} has ${pubs.length} publishers [${pubs.join(', ')}], want exactly 1`)
  }
  // Disjoint filters -- the flow streams AND the system streams (DLQ): a dead-letter subject
  // captured by a flow stream too would be stored twice, and the "one publisher per stream" and
  // "address under its module's stream" guards stay flow-only.
  const everyStream = { ...streams, ...input.systemStreams }
  const everyName = Object.keys(everyStream)
  for (const n of Object.keys(input.systemStreams ?? {})) {
    if (n in streams) out.push(`system stream ${n} has the name of a flow stream`)
  }
  for (let i = 0; i < everyName.length; i++) {
    for (let j = i + 1; j < everyName.length; j++) {
      const a = everyStream[everyName[i]!]!
      const b = everyStream[everyName[j]!]!
      for (const x of a.subjects) {
        for (const y of b.subjects) {
          if (patternsOverlap(x, y)) out.push(`streams ${a.name} (${x}) and ${b.name} (${y}) overlap`)
        }
      }
    }
  }
  // Registry: every owner mapped or listed; every mapped address under its
  // module's OWNED stream; no-stream entries not stale.
  const owners = new Set(input.registry.map((a) => a.owner))
  const noStreamOwners = new Set(input.noStream.map((e) => e.owner))
  for (const owner of owners) {
    if (!(owner in input.ownerToModule) && !noStreamOwners.has(owner)) {
      out.push(`registry owner ${owner} is neither mapped in OWNER_TO_MODULE nor listed in NO_STREAM`)
    }
  }
  let checked = 0
  for (const a of input.registry) {
    const mod = input.ownerToModule[a.owner]
    if (mod === undefined) {
      const entry = input.noStream.find((e) => e.owner === a.owner && e.segment === segmentOf(a.address))
      if (!entry && noStreamOwners.has(a.owner)) {
        out.push(`registry address ${a.address} (owner ${a.owner}) has no stream and no NO_STREAM entry`)
      }
      continue
    }
    checked++
    const flow = flows[mod]
    const owned = (flow?.publishes ?? []).flatMap((s) => streams[s]?.subjects ?? [])
    if (!owned.some((p) => patternMatches(p, concrete(a.address)))) {
      out.push(`registry address ${a.address} (owner ${a.owner} -> ${mod}) is not under any stream ${mod} publishes [${owned.join(', ')}]`)
    }
  }
  for (const e of input.noStream) {
    const used = input.registry.some((a) => a.owner === e.owner && segmentOf(a.address) === e.segment)
    const captured = Object.values(streams).some((s) => s.subjects.some((p) => patternMatches(p, `gremion.x.${e.segment}.x`)))
    if (!used || captured) {
      out.push(`stale no-stream entry ${e.owner}/${e.segment} (until ${e.until}): ${!used ? 'no registry address uses it' : 'a stream now captures it'}`)
    }
  }
  if (checked === 0) out.push('zero registry addresses checked -- the address rule would pass vacuously')

  // Every catalogue module is classified exactly once.
  for (const id of input.moduleIds) {
    if (!(id in flows) && !input.noBroker.includes(id)) out.push(`module ${id} is in neither FLOWS nor NO_BROKER`)
  }
  for (const id of input.noBroker) {
    if (id in flows) out.push(`module ${id} is in both FLOWS and NO_BROKER`)
  }
  return [...new Set(out)]
}

/** The streams the stream-topology knows, as the matrix reads them. */
export const TOPOLOGY: Readonly<Record<string, { name: string; subjects: string[] }>> = STREAMS
