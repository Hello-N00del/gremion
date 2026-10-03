// packages/tenant-store/src/lifecycle/types.ts — the lifecycle's injected dependencies.
import type { Sql } from '@gremion/db'
import type { CatalogueEntry } from '@gremion/module-catalogue/runtime'
import type { PhaseFor } from '../phase.js'
import type { RunMigrationsHooks } from '../runner.js'

/** Who asked (SCHEMA module_enablement_enabled_by_check: a person or an operator). */
export interface Actor {
  kind: 'person' | 'operator'
  id: string
}

/** The level-1 gate's references (TRD-063, PRD-REG-005). */
export interface GateResult {
  isolationTestResultId: string
  dpiaDecisionId: string
  crossBodyTestResultId?: string | null
}

/**
 * Q3: required, no default (default-deny, PRD-PLAT-012). null refuses the
 * enable. TASK-044 implements it in lifecycle/enable-gate/.
 */
export type EnableGate = (tenantId: string, moduleId: string) => GateResult | null | Promise<GateResult | null>

/** One PostgreSQL server (a compose service labelled org.gremion.postgres). */
export interface ModuleServer {
  /**
   * A connection with CREATEDB and CREATEROLE (the server's POSTGRES_USER) to
   * the server's maintenance database. The lifecycle runs CREATE/DROP
   * DATABASE and the role DDL on it; it is never a (tenant, module) database.
   */
  admin: Sql
  /**
   * A DIRECT pool (max >= 2, never a pooler: the runner refuses one) to
   * `database` on this server. With `role`, the pool's sessions start as that
   * role (startup `options=-c role=<role>`), so the migrations and every
   * object they create are owned by it (Q4). The caller ends the pool.
   */
  open(database: string, options?: { role?: string }): Sql | Promise<Sql>
}

export interface ExportTarget {
  service: string
  database: string
}

/** pg_dump -Fc and pg_restore --list, injected (pgDumpExporter is the implementation). */
export interface Exporter {
  /** Writes a custom-format dump of target.database to `file` (which does not exist yet). */
  dump(target: ExportTarget, file: string): Promise<void>
  /** The archive's table of contents (`pg_restore --list`). Throws when it does not parse. */
  list(file: string): Promise<string>
}

export type LifecycleStep = 'enabling' | 'roles' | 'created' | 'migrated' | 'enabled' | 'disabling' | 'exported' | 'dropped'

export interface LifecycleDeps {
  /** A connection to gremion_platform (asserted by name before anything else). */
  platform: Sql
  /** The server behind a compose service name (runtime.database.postgresService). */
  server(service: string): ModuleServer
  enableGate: EnableGate
  /** The app role's password per module (Q4); 16-256 printable ASCII. */
  secrets: { appPassword(moduleId: string): string | Promise<string> }
  exporter: Exporter
  /** Exports land in <exportDir>/<tenant>/<module>/<utc>.dump, mode 0600 (Q7). */
  exportDir: string
  /**
   * TASK-075: the release an enable ships, written into every ledger row it
   * adds (release_ref, 1-64 characters). Required when the module declares a
   * database.
   */
  releaseRef?: string
  /**
   * TASK-075: the phase of a headerless module migration. Default: the kernel
   * baseline of chain `module-<id>` (scripts/migrations/runner/expand-contract-baseline.json).
   */
  phaseFor?: (moduleId: string) => PhaseFor | undefined
  /**
   * TASK-075 (TRD-206): hooks for a migration run on a database that ALREADY
   * existed (an upgrade or a resumed enable): the pre-migration dump. A
   * database this enable just created gets none (nothing to lose, README).
   */
  upgradeHooks?: RunMigrationsHooks
  /** Test seam: called after each step's state is written (crash injection). */
  hooks?: { afterStep?(step: LifecycleStep, ctx: { tenantId: string; moduleId: string; database: string | null }): void | Promise<void> }
  log?: (line: string) => void
}

/** The module as the catalogue holds it (loadCatalogue). */
export type LifecycleModule = Pick<CatalogueEntry, 'id' | 'dir' | 'moduleJson'>

export interface EnableResult {
  tenantId: string
  moduleId: string
  /** null for a module that declares no database. */
  database: string | null
  /** true when this call created the database. */
  created: boolean
  /** migrations this call applied. */
  applied: string[]
  /** true when the module was already enabled and nothing was written. */
  noop: boolean
}

export interface DisableResult {
  tenantId: string
  moduleId: string
  database: string | null
  dropped: boolean
  export: { path: string; sha256: string; bytes: number } | null
  noop: boolean
}
