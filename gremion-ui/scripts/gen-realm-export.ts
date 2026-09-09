// Setup-time generator (Pillar-1 P0.2): write docker/keycloak/realm-export.json
// from realm-export.base.json + enabled modules' realm fragments, gated by the
// target vertical's config. Run BEFORE `docker compose up`. Usage:
//   tsx scripts/gen-realm-export.ts [--config <path>]
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODULE_MANIFESTS } from '../src/lib/modules/registry'
import { composeRealm } from '../src/lib/modules/realm'
import { parseConfig } from '../src/lib/server/config'

const repoRoot = join(import.meta.dirname, '..', '..')
const kcDir = join(repoRoot, 'docker', 'keycloak')
const configArgIdx = process.argv.indexOf('--config')
const configPath = configArgIdx >= 0 ? process.argv[configArgIdx + 1] : (process.env.CONFIG_PATH ?? join(repoRoot, 'config', 'config.json'))

const base = JSON.parse(readFileSync(join(kcDir, 'realm-export.base.json'), 'utf-8'))
// #262 D4: validate the vertical config through parseConfig (throwing Zod
// validation + DEFAULT_CONFIG merge) instead of feeding raw JSON.parse straight
// into composeRealm. This shares the runtime's module-default semantics — a
// legal-but-sparse config (no `modules` key) is back-filled all-enabled instead
// of crashing with a TypeError, and a type-confused value surfaces a real
// validation message rather than silently diverging from the booted app.
const config = parseConfig(JSON.parse(readFileSync(configPath, 'utf-8')))
const realm = composeRealm(base, MODULE_MANIFESTS, config)
writeFileSync(join(kcDir, 'realm-export.json'), JSON.stringify(realm, null, 2) + '\n')
console.info(`[gen-realm-export] wrote realm-export.json (finance=${config.modules?.finance})`)
