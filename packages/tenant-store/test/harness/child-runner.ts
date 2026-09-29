// packages/tenant-store/test/harness/child-runner.ts
//
// One runner PROCESS for the concurrency test. It connects, prints `ready`,
// waits for `go` on stdin (the barrier), runs, and prints one JSON result
// line. T020_CHILD_VARIANT picks runMigrations or the readThenApply fixture;
// T020_HOLD_MS keeps the first file's slot open (runMigrations: in preApply,
// under the lock; readThenApply: between its read and its apply) so the
// other process provably overlaps.
import { createInterface } from 'node:readline'
import postgres from 'postgres'
import { runMigrations } from '../../src/runner.js'
import { readThenApply } from '../fixtures/read-then-apply.js'
import { assertNonProductionDbUrl } from './db.js'
import { FIXTURE_RELEASE } from './migrations.js'

const url = process.env.T020_CHILD_URL!
const dir = process.env.T020_CHILD_DIR!
const name = process.env.T020_CHILD_NAME!
const variant = process.env.T020_CHILD_VARIANT ?? 'runner'
const holdMs = Number(process.env.T020_HOLD_MS ?? '0')

assertNonProductionDbUrl(url)
const sql = postgres(url, { max: 2, onnotice: () => {}, connection: { application_name: name } })

async function main() {
  await sql`SELECT 1`
  process.stdout.write('ready\n')
  const rl = createInterface({ input: process.stdin })
  for await (const line of rl) if (line.trim() === 'go') break
  rl.close()
  try {
    let first = true
    const result =
      variant === 'readThenApply'
        ? await readThenApply({ sql, dir, holdMs })
        : await runMigrations({
            sql,
            dir,
            ...FIXTURE_RELEASE,
            log: (l) => process.stderr.write(`${l}\n`),
            hooks: {
              preApply: async () => {
                if (first) await new Promise((r) => setTimeout(r, holdMs))
                first = false
              },
            },
          })
    process.stdout.write(JSON.stringify({ name, applied: result.applied }) + '\n')
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string }; message: string; file?: string; files?: string[]; sawPending?: string[] }
    const file = e.file ?? e.files?.[0]
    process.stdout.write(JSON.stringify({ name, applied: [], error: { code: e.cause?.code ?? e.code, message: e.message, file, sawPending: e.sawPending } }) + '\n')
  } finally {
    await sql.end({ timeout: 5 })
  }
}
main()
