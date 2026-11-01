// src/lib/server/module-karenz/retained/extractors.ts
// Module Karenz (phase 2, Task 10): the three registries of the retained copies.
//
//   extractors   what a module hands over at switch-off: records the council must keep after the
//                module database is gone, as lines (RetentionExtractor). Registered by the module's
//                own register.server.ts, never imported by the kernel.
//   class policy EXTENSION POINT for phase 3: when a class's hold ends and whether names stay legible
//                under an Art. 17 erasure (RetentionClassPolicy). Without a registered policy a copy
//                has no automatic deletion and its names are redacted on erasure.
//   sinks        where a sealed copy is published beside the settings download (RetainedSink), for
//                example the files module's per-tenant folder. Task 16 implements the files sink;
//                the engine drives publication as one retried step per (record, sink) (Task 11).
//
// Registration is idempotent: registering an id again replaces the earlier entry in place (a
// server-init hook may run twice in one process), and the order of first registration is kept.
import type { KarenzContext } from '../participants'

/** One line of a retained copy. */
export interface RetainedLine {
  /** Stable id of the record inside its source, for the reader of the copy. */
  id: string
  /** The record itself (JSON-safe). Person fields inside it are named by `persons`. */
  data: Record<string, unknown>
  /** Every person the line names: the id and the field of `data` that shows the person. Used to redact after an erasure. */
  persons: readonly { id: string; field: string }[]
}

export interface RetentionExtractor {
  /** Unique, stable id; a copy is written once per (Karenz row, extractor id). */
  id: string
  /** The module catalogue id whose switch-off runs this extractor. */
  catalogueId: string
  /** The retention class of the lines (a catalogue row such as RC-GOV-RES). */
  retentionClass: string
  /** Lines of the module database as it is at switch-off. Throwing fails the extractor, never the others. */
  extract(ctx: KarenzContext): AsyncIterable<RetainedLine>
}

/** EXTENSION POINT for phase 3 (finance): hold end per class and the legible-names exception under Art. 17. */
export interface RetentionClassPolicy {
  retentionClass: string
  /** The date until which the copy must be kept, or null for no automatic deletion in phase 2. */
  holdUntil(i: { startedAt: Date }): Date | null
  /** True when names stay legible in the served copy after an erasure (catalogue section 8 item 3). */
  keepsNamesUnderErasure: boolean
}

/**
 * SINK CONTRACT (owned here; Task 16 implements the files sink). `publish` OVERWRITES by filename, so
 * it is idempotent and a republish after an erasure replaces the earlier document.
 */
export interface RetainedSink {
  id: string
  available(tenant: KarenzContext['tenant']): boolean
  publish(ctx: { tenant: KarenzContext['tenant']; recordId: string; title: string; filename: string; ndjson: Buffer }): Promise<void>
}

const DEFAULT_POLICY = (retentionClass: string): RetentionClassPolicy => ({ retentionClass, holdUntil: () => null, keepsNamesUnderErasure: false })

const extractors = new Map<string, RetentionExtractor>()
const policies = new Map<string, RetentionClassPolicy>()
const sinks = new Map<string, RetainedSink>()

export function registerRetentionExtractor(e: RetentionExtractor): void {
  extractors.set(e.id, e)
}

/** The extractors of one catalogue id, in registration order. */
export function extractorsFor(catalogueId: string): readonly RetentionExtractor[] {
  return [...extractors.values()].filter((e) => e.catalogueId === catalogueId)
}

export function registerRetentionClassPolicy(p: RetentionClassPolicy): void {
  policies.set(p.retentionClass, p)
}

/** The policy of a class; a class without one is never deleted automatically and has its names redacted. */
export function policyFor(retentionClass: string): RetentionClassPolicy {
  return policies.get(retentionClass) ?? DEFAULT_POLICY(retentionClass)
}

export function registerRetainedSink(s: RetainedSink): void {
  sinks.set(s.id, s)
}

export function retainedSinks(): readonly RetainedSink[] {
  return [...sinks.values()]
}

/** Test-only: forget every registration. */
export function _clearRetentionRegistriesForTests(): void {
  extractors.clear()
  policies.clear()
  sinks.clear()
}
