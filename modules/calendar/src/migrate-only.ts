// modules/calendar/src/migrate-only.ts
//
// The CD leaf step: `node dist/index.js --migrate-only`.
//
// Continuous deployment runs one such container per leaf service before the new colour starts and
// reads ONE JSON line of counts from it (`v`, `total`, `migrated`, `skipped`, `failed`; exit 0 needs
// failed = 0 and migrated + skipped + failed = total).
//
// For the calendar leaf the entry has nothing left to migrate. A customer's calendar lives in the
// database the module lifecycle owns, t_<tenant>__calendar, and the module step of the same release
// creates, migrates and grants it (enableModule / the upgrade of an enabled module). The leaf never
// creates or migrates a customer database any more (src/tenant-store.ts), so this entry touches no
// database at all: it answers the contract with zero counts, starts no server, no scheduler, no NATS
// client and no outbox relay, and takes no argument. It stays only because the host's fixed leaf list
// still runs it for this service.
//
// The calendar_<slug> databases of the earlier layout are retired data: scripts/move-to-lifecycle-db.mjs
// copies them into the lifecycle databases and marks them retired; the leaf step does not migrate them.

const LEAF = 'calendar'

export interface MigrateOnlyCounts {
  v: 1
  total: number
  migrated: number
  skipped: number
  failed: number
}

/** The counts of a run that opened nothing. */
export function emptyCounts(): MigrateOnlyCounts {
  return { v: 1, total: 0, migrated: 0, skipped: 0, failed: 0 }
}

function writeLine(line: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(line + '\n', () => resolve())
  })
}

/**
 * `node dist/index.js --migrate-only`. Returns the exit code; index.ts exits with it. The counts line
 * is the only thing on stdout. `argv` is for tests (the real entry passes none).
 */
export async function runMigrateOnlyCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.some((a) => a !== '--migrate-only')) {
    // No slug argument (or any other).
    process.stderr.write(`[${LEAF}] --migrate-only takes no other argument\n`)
    return 2
  }
  await writeLine(JSON.stringify(emptyCounts()))
  return 0
}
