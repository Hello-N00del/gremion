// Extracts the host-form commands of docs/runbooks/dead-letter.md and maps each to its scratch
// equivalent: the doc is the spec, the test runs what it says (TASK-079 "Runbook" acceptance).
//
//   host form A  docker compose --env-file /opt/gremion/etc/env/app-<colour>.env run --rm --no-deps
//                  --entrypoint pnpm tenant-create exec <tool> <args>      (tool: events | nats-auth)
//   host form B  docker compose --env-file /opt/gremion/etc/env/app-<colour>.env exec <service>
//                  pnpm exec events <args>
//
// The scratch equivalent of `pnpm exec <tool>` in the migrate image is `node packages/<tool>/bin/<tool>.mjs`.
// Anything that is not one of the two forms is a drift the test reports by name.
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const REPO = path.resolve(import.meta.dirname, '../../..')
export const RUNBOOK = path.join(REPO, 'docs/runbooks/dead-letter.md')

export interface RunbookCommand {
  /** The line as the doc prints it. */
  line: string
  form: 'A' | 'B'
  tool: 'events' | 'nats-auth'
  /** The tool's arguments, still carrying <placeholders>. */
  args: string[]
}

const ENV = String.raw`--env-file /opt/gremion/etc/env/app-(?:blue|green)\.env`
const FORM_A = new RegExp(String.raw`^docker compose ${ENV} run --rm --no-deps --entrypoint pnpm tenant-create exec (events|nats-auth) (.+)$`)
const FORM_B = new RegExp(String.raw`^docker compose ${ENV} exec <service> pnpm exec (events) (.+)$`)

/** Every command line of the doc's fenced code blocks, parsed; an unrecognised `docker compose` line throws. */
export function extractCommands(text = readFileSync(RUNBOOK, 'utf8')): RunbookCommand[] {
  const out: RunbookCommand[] = []
  let inFence = false
  for (const raw of text.split(/\r?\n/)) {
    if (/^```/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (!inFence || !raw.trim() || raw.trim().startsWith('#')) continue
    const line = raw.trim()
    const a = FORM_A.exec(line)
    const b = FORM_B.exec(line)
    const m = a ?? b
    if (!m) throw new Error(`dead-letter.md: a fenced command is neither host form A nor B: ${line}`)
    out.push({ line, form: a ? 'A' : 'B', tool: m[1] as RunbookCommand['tool'], args: m[2]!.trim().split(/\s+/) })
  }
  return out
}

/** Substitutes every <placeholder>; a placeholder with no value is an error (the doc invented one). */
export function fill(args: string[], values: Record<string, string>): string[] {
  return args.map((a) =>
    a.replace(/<([a-z-]+)>/g, (_m, name: string) => {
      if (!(name in values)) throw new Error(`dead-letter.md: placeholder <${name}> has no value in the test (the doc drifted)`)
      return values[name]!
    }),
  )
}

/** `node <bin> <args>` for the scratch run. */
export const binOf = (tool: RunbookCommand['tool']): string => path.join(REPO, 'packages', tool, 'bin', `${tool}.mjs`)
