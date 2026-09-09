// packages/db/src/client.ts
import postgres from 'postgres';

/**
 * Connection profile for one tenant's pool. Replaces the bare-url arg so
 * per-tenant `max` (cut 10->2-4, P2.1a/D4) and prepared-statement support (off
 * behind PgBouncer txn mode, P2.1b) are tunable from the registry.
 */
export interface DbProfile {
  url: string;
  /** Per-client pool size. Default tier = 3 (was a process-global 10). */
  max: number;
  /** prepared statements; set false behind PgBouncer < 1.21 txn mode. */
  prepare: boolean;
}

export function createDb(profile: DbProfile) {
  return postgres(profile.url, {
    max: profile.max,
    prepare: profile.prepare,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

export type Sql = ReturnType<typeof createDb>;
