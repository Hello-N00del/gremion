// packages/retention/src/cli.ts -- `node packages/retention/bin/retention.mjs <cmd>`.
//   render [--check]      rewrite docker/loki/loki.yaml from the registry, or fail when it differs
//   check-catalogue       fail when the registry and docs/compliance/retention-catalogue.md disagree
//   scan-actors           fail when audit_log.user_id is free text in the kernel-data chain
//   generate --out <f> --version <v> --date <YYYY-MM-DD>   write the German Loeschkonzept HTML
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanActorSchema } from './actors.ts'
import { catalogueDrift } from './catalogue.ts'
import { generateLoeschkonzept } from './generator.ts'
import { renderLoki } from './loki.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const LOKI = join(ROOT, 'docker/loki/loki.yaml')
const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

export async function main(argv: readonly string[]): Promise<number> {
  const [cmd, ...rest] = argv
  const flag = (n: string): string | undefined => {
    const i = rest.indexOf(n)
    return i >= 0 ? rest[i + 1] : undefined
  }
  if (cmd === 'render') {
    const want = renderLoki()
    if (rest.includes('--check')) {
      if (read(LOKI) === want) return 0
      console.error('docker/loki/loki.yaml differs from the render: run `node packages/retention/bin/retention.mjs render`')
      return 1
    }
    writeFileSync(LOKI, want)
    return 0
  }
  if (cmd === 'check-catalogue') {
    const problems = catalogueDrift(read(join(ROOT, 'docs/compliance/retention-catalogue.md')))
    for (const p of problems) console.error(p)
    return problems.length ? 1 : 0
  }
  if (cmd === 'scan-actors') {
    const dir = join(ROOT, 'gremion-ui/migrations')
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    const findings = scanActorSchema(files.map((name) => ({ name, sql: read(join(dir, name)) })))
    for (const f of findings) console.error(`${f.where}: ${f.problem}`)
    return findings.length ? 1 : 0
  }
  if (cmd === 'generate') {
    const out = flag('--out')
    const version = flag('--version')
    const date = flag('--date')
    if (!out || !version || !date) {
      console.error('usage: generate --out <file> --version <v> --date <YYYY-MM-DD>')
      return 2
    }
    writeFileSync(out, generateLoeschkonzept({ version, generatedOn: date }))
    return 0
  }
  console.error('usage: retention render [--check] | check-catalogue | scan-actors | generate --out <f> --version <v> --date <d>')
  return 2
}
