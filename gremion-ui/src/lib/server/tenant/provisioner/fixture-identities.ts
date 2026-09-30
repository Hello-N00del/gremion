// src/lib/server/tenant/provisioner/fixture-identities.ts
// TASK-043 Q10: what marks a FIXTURE user in a live realm, for reconcile's
// narrowed `no-fixture-users` check (#239):
//   - a seed-subject id: every UUID the kernel chain's seed migrations name
//     (`*_seed.sql`, pad-agnostic: the legacy pad-3 name and the pad-4
//     0005_dev_seed.sql alike -- the TASK-029 renumber changed the pad, not
//     the meaning);
//   - a template fixture username: every user of the shipped blueprints and
//     the dev superuser the seed creates.
// Pure over its inputs; the CLI reads the files.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MUNICIPAL_BLUEPRINT } from '$lib/server/seed/municipal-blueprint'
import { STURA_BLUEPRINT } from '$lib/server/seed/org-blueprint'

/** A seed migration, whatever its pad width. */
export const SEED_FILE = /^\d+_[a-z0-9_]*seed\.sql$/

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/** Every UUID named by the seed files among `files` (lowercase, unique, sorted). */
export function seedSubjectIdsFrom(files: readonly { name: string; text: string }[]): string[] {
  const out = new Set<string>()
  for (const f of files) {
    if (!SEED_FILE.test(f.name)) continue
    for (const m of f.text.match(UUID) ?? []) out.add(m.toLowerCase())
  }
  return [...out].sort()
}

export function seedSubjectIds(migrationsDir: string): string[] {
  const files = readdirSync(migrationsDir)
    .filter((n) => SEED_FILE.test(n))
    .map((name) => ({ name, text: readFileSync(join(migrationsDir, name), 'utf-8') }))
  return seedSubjectIdsFrom(files)
}

/** The dev superuser seed.ts creates beside the blueprint users. */
export const DEV_SUPERUSER = 'dev.admin'

export function fixtureUsernames(): string[] {
  const out = new Set<string>([DEV_SUPERUSER])
  for (const bp of [STURA_BLUEPRINT, MUNICIPAL_BLUEPRINT]) for (const u of bp.users) out.add(u.username.toLowerCase())
  return [...out].sort()
}

export function fixtureIdentities(migrationsDir: string): { ids: ReadonlySet<string>; usernames: ReadonlySet<string> } {
  return { ids: new Set(seedSubjectIds(migrationsDir)), usernames: new Set(fixtureUsernames()) }
}
