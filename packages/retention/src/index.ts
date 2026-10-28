// @gremion/retention (TASK-033-a): the six log deletion classes, the rendered
// Loki retention, the catalogue parser, the generated Loeschkonzept and the
// actor scan. ESM, pure and DB-free at import. The scheduled purge is NOT here:
// it is packages/tenant-store (lifecycle/purge.ts, verb purge-run), which reads
// its windows from this package's catalogue parser in its tests. Names kernel
// streams only.
export { ACTOR_FIELD_ALLOWLIST, scanActorSchema, scanActorValues, UUID_RE } from './actors.ts'
export type { ActorFinding } from './actors.ts'
export { catalogueDrift, parseCacheTtlHours, parseLogRows } from './catalogue.ts'
export type { CatalogueLogRow } from './catalogue.ts'
export { generateLoeschkonzept } from './generator.ts'
export type { LoeschkonzeptInput, ModuleCategory } from './generator.ts'
export { lokiGlobalDays, renderLoki } from './loki.ts'
export {
  CACHE_TTL_HOURS, CEILING_DAYS, DB_PURGE_TICK_DAYS, dbWindowDays, enforcedDays, formatDuration, LOG_CLASSES, logClass,
  lokiClasses, lokiWorstCaseMinutes, maxLokiWindowDays,
} from './registry.ts'
export type { LogClass, LogClassId } from './registry.ts'
