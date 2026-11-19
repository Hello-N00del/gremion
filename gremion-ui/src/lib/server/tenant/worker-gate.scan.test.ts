import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Static scan (CD stage 1, U12b): every background tick of gremion-ui goes through
// forEachActiveTenant, the one seam where the worker gate (worker-gate.ts) is read.
//
// A tick that does not is invisible to the gate: when a release turns the workers of a colour
// off, that tick would keep running in both colours at once. So the scan lists every
// `setInterval`, `cron.schedule` and boot-worker starter (`superviseWorker`) in the server
// code and the module app code, and requires its callback to reach forEachActiveTenant. A
// call that does not is named in the failure and must either be put behind the gate or be
// added to NOT_GATED below WITH its reason. That list IS the "not gated" residual of the plan.
//
// Limits, stated so nobody reads this as more than it is: it is a text scan. It sees the call
// sites above, not a recursive `setTimeout` loop and not a timer created by a dependency.

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..', '..', '..')

type Kind = 'setInterval' | 'cron.schedule' | 'superviseWorker'

interface NotGated {
  /** Path below `gremion-ui/src/` or `modules/<id>/app/` (the module overlay maps one onto the other). */
  file: string
  kind: Kind
  /** How many call sites of that kind the file may hold. A new one fails the scan. */
  count: number
  reason: string
}

/**
 * Background starters that deliberately do NOT go through forEachActiveTenant, with the reason.
 * The gate does not stop these. This is Open Decision 3's residual, kept honest by this test.
 */
const NOT_GATED: readonly NotGated[] = [
  {
    file: 'lib/server/calendar/register.server.ts',
    kind: 'superviseWorker',
    count: 1,
    reason: 'the calendar audit consumer is a durable NATS consumer, not a periodic tick; it has no per-tenant loop',
  },
  {
    file: 'lib/server/content/register.server.ts',
    kind: 'superviseWorker',
    count: 1,
    reason: 'the content audit consumer is a durable NATS consumer, not a periodic tick; it has no per-tenant loop',
  },
  {
    file: 'lib/server/newsletter/register.server.ts',
    kind: 'superviseWorker',
    count: 1,
    reason: 'the newsletter audit consumer is a durable NATS consumer, not a periodic tick; it has no per-tenant loop',
  },
  {
    file: 'routes/api/messages/sync/+server.ts',
    kind: 'setInterval',
    count: 1,
    reason: 'a keep-alive of one open event stream, bound to that request; it is not background work',
  },
]

// ---------------------------------------------------------------------------------------------
// The scanner. It first blanks comments and the CONTENT of string literals (so a mention in
// prose neither counts as a tick nor as the gate), then finds the call sites, then reads each
// call's arguments with balanced brackets.
// ---------------------------------------------------------------------------------------------

const fill = (s: string) => s.replace(/[^\n]/g, ' ')

/** Replace comments and string contents with spaces, keeping every offset and newline. */
export function blank(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i)
      const stop = end === -1 ? n : end
      out += fill(src.slice(i, stop))
      i = stop
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      out += fill(src.slice(i, stop))
      i = stop
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++
        j++
      }
      out += c + fill(src.slice(i + 1, Math.min(j, n))) + (j < n ? c : '')
      i = j + 1
    } else {
      out += c
      i++
    }
  }
  return out
}

/** Index of the bracket that closes the one at `open` (or -1). */
function closing(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** First top-level argument of the argument text. */
function firstArg(args: string): string {
  let depth = 0
  for (let i = 0; i < args.length; i++) {
    const c = args[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) return args.slice(0, i).trim()
  }
  return args.trim()
}

/** The text of the statement that declares `name` (const arrow, let, or function), or ''. */
function declaration(text: string, name: string): string {
  const m = new RegExp(`\\b(?:const|let|var|function)\\s+${name.replace(/\$/g, '\\$')}\\b`).exec(text)
  if (!m) return ''
  let depth = 0
  let sawBody = false
  for (let i = m.index; i < text.length; i++) {
    const c = text[i]
    if (c === '(' || c === '[' || c === '{') {
      depth++
      if (c === '{') sawBody = true
    } else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0 && c === '}' && sawBody && /^\s*function\b/.test(text.slice(m.index, m.index + 12))) {
        return text.slice(m.index, i + 1)
      }
    } else if (depth === 0 && c === ';') {
      return text.slice(m.index, i)
    } else if (depth === 0 && c === '\n') {
      const before = text.slice(m.index, i).trimEnd()
      const after = text.slice(i).trimStart()
      const hasValue = /=\s*\S/.test(before) || /=>\s*\S/.test(before)
      if (hasValue && !/(=>|=|,|\+|-|\*|\/|&&|\|\||\?|:|\()$/.test(before) && !/^[.?:&|+,)]/.test(after)) {
        return text.slice(m.index, i)
      }
    }
  }
  return text.slice(m.index)
}

export interface Site {
  kind: Kind
  line: number
  gated: boolean
}

const PATTERNS: readonly { kind: Kind; re: RegExp }[] = [
  { kind: 'setInterval', re: /(?<![\w$.])setInterval\s*\(/g },
  { kind: 'cron.schedule', re: /\bcron\s*\.\s*schedule\s*\(/g },
  { kind: 'superviseWorker', re: /(?<![\w$.])superviseWorker\s*\(/g },
]

/** Every tick-starting call in one source text, and whether its work reaches forEachActiveTenant. */
export function scanSource(src: string): Site[] {
  const text = blank(src)
  const sites: Site[] = []
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const open = m.index + m[0].length - 1
      // The declaration `function superviseWorker(` is not a call site.
      if (/\bfunction\s+$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue
      const close = closing(text, open)
      const args = close === -1 ? text.slice(open + 1) : text.slice(open + 1, close)
      let gated = args.includes('forEachActiveTenant')
      if (!gated) {
        // `setInterval(tick, ms)` / `cron.schedule(x, tick)`: follow an identifier to its declaration.
        const candidates = [firstArg(args), ...args.split(',').map((a) => a.trim())]
        for (const id of candidates) {
          if (/^[A-Za-z_$][\w$]*$/.test(id) && declaration(text, id).includes('forEachActiveTenant')) {
            gated = true
            break
          }
        }
      }
      sites.push({ kind, line: text.slice(0, m.index).split('\n').length, gated })
    }
  }
  return sites.toSorted((a, b) => a.line - b.line)
}

// ---------------------------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.svelte-kit' || name === 'build' || name.startsWith('.')) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (
      /\.(ts|js|mjs)$/.test(name) &&
      !/\.(test|spec|integration\.test|d)\.ts$/.test(name) &&
      !name.endsWith('.generated.ts')
    ) {
      out.push(p)
    }
  }
  return out
}

/** Server and module app code: `gremion-ui/src` and `modules/<id>/app`. */
function sourceFiles(): { path: string; key: string }[] {
  const files: { path: string; key: string }[] = []
  for (const p of walk(join(REPO, 'gremion-ui', 'src'))) {
    files.push({ path: p, key: relative(join(REPO, 'gremion-ui', 'src'), p).split(sep).join('/') })
  }
  const modulesDir = join(REPO, 'modules')
  for (const id of readdirSync(modulesDir)) {
    const app = join(modulesDir, id, 'app')
    for (const p of walk(app)) {
      files.push({ path: p, key: relative(app, p).split(sep).join('/') })
    }
  }
  return files
}

describe('scanner self-test (the scan below is only worth what these prove)', () => {
  it('names a setInterval whose callback never reaches the gate', () => {
    const sites = scanSource(`setInterval(() => doWork(), 1000)`)
    expect(sites).toEqual([{ kind: 'setInterval', line: 1, gated: false }])
  })

  it('names an ungated cron.schedule and an ungated superviseWorker', () => {
    const sites = scanSource(
      `cron.schedule('* * * * *', () => run())\nawait superviseWorker({ name: 'x', start: () => go() })`,
    )
    expect(sites.map((s) => [s.kind, s.gated])).toEqual([
      ['cron.schedule', false],
      ['superviseWorker', false],
    ])
  })

  it('accepts a callback that calls forEachActiveTenant, inline', () => {
    const sites = scanSource(`setInterval(() => forEachActiveTenant('w', (ctx) => run(ctx)), 5000).unref()`)
    expect(sites.map((s) => s.gated)).toEqual([true])
  })

  it('accepts an identifier that is declared as a gated arrow, on one line or several', () => {
    const one = scanSource(`const tick = () => forEachActiveTenant('w', f)\nsetInterval(tick, 1)`)
    expect(one.map((s) => s.gated)).toEqual([true])
    const many = scanSource(
      `const tick2 = () =>\n  forEachActiveTenant('w', async () => {\n    await x()\n  })\nsetInterval(tick2, 1)`,
    )
    expect(many.map((s) => s.gated)).toEqual([true])
  })

  it('rejects an identifier whose declaration does not reach the gate, even if a later line does', () => {
    const sites = scanSource(`const tick = () => other()\nconst unrelated = () => forEachActiveTenant('w', f)\nsetInterval(tick, 1)`)
    expect(sites.map((s) => s.gated)).toEqual([false])
  })

  it('ignores prose: the word in a comment or a string is neither a tick nor the gate', () => {
    expect(scanSource(`// setInterval(x, 1)\n/* cron.schedule(a, b) */\nconst s = 'setInterval(a, b)'`)).toEqual([])
    const sites = scanSource(`setInterval(() => { log('forEachActiveTenant'); /* forEachActiveTenant */ }, 1)`)
    expect(sites.map((s) => s.gated)).toEqual([false])
  })

  it('does not take the declaration of superviseWorker, a method call or a longer name for a call', () => {
    expect(scanSource(`export async function superviseWorker(opts) {}\nfoo.setInterval(a, b)\nmysetInterval(a)`)).toEqual([])
  })

  it('a gated tick next to an ungated one: only the ungated one is false', () => {
    const sites = scanSource(
      `setInterval(() => forEachActiveTenant('a', f), 1)\nsetInterval(() => bare(), 2)`,
    )
    expect(sites.map((s) => [s.line, s.gated])).toEqual([
      [1, true],
      [2, false],
    ])
  })
})

describe('every background tick of gremion-ui goes through forEachActiveTenant', () => {
  const files = sourceFiles()
  // The module overlay copies modules/<id>/app into gremion-ui/src at build time: the same file is
  // then seen twice under one key. Count each call site once.
  const unique = new Map<string, Site & { key: string }>()
  for (const { path, key } of files) {
    for (const s of scanSource(readFileSync(path, 'utf8'))) unique.set(`${key}:${s.kind}:${s.line}`, { ...s, key })
  }
  const found = [...unique.values()]

  it('the scan collected the known ticks (a scan that finds nothing proves nothing)', () => {
    const gated = found.filter((s) => s.gated).map((s) => s.key)
    // The provisioning worker and the audit-integrity tick of the kernel, the Karenz and module
    // switch workers, the governance workers, and the module ticks (calendar, content).
    for (const known of [
      'lib/server/governance/provisioning/worker.ts',
      'hooks.server.ts',
      'lib/server/module-karenz/register.server.ts',
      'lib/server/module-switch/register.server.ts',
      'lib/server/governance/register.server.ts',
      'lib/server/calendar/notification-scheduler.ts',
      'lib/server/calendar/caldav-sync.ts',
      'lib/server/content/register.server.ts',
    ]) {
      expect(gated, `the scan did not see the tick in ${known}`).toContain(known)
    }
    expect(found.length).toBeGreaterThanOrEqual(10)
  })

  it('no tick bypasses the gate unless it is on the reviewed list with a reason', () => {
    const ungated = found.filter((s) => !s.gated)
    const problems: string[] = []

    for (const s of ungated) {
      const allowed = NOT_GATED.find((a) => a.file === s.key && a.kind === s.kind)
      if (!allowed) {
        problems.push(
          `${s.key}:${s.line} starts a ${s.kind} whose work does not go through forEachActiveTenant, ` +
            `so the worker gate cannot stop it. Put it behind forEachActiveTenant, or add it to NOT_GATED with the reason.`,
        )
      }
    }
    for (const a of NOT_GATED) {
      const n = ungated.filter((s) => s.key === a.file && s.kind === a.kind).length
      if (n > a.count) {
        problems.push(`${a.file} now holds ${n} ungated ${a.kind} call(s), the reviewed list allows ${a.count}.`)
      } else if (n < a.count) {
        problems.push(`${a.file}: NOT_GATED expects ${a.count} ungated ${a.kind} call(s) but found ${n}; remove the stale entry.`)
      }
    }

    expect(problems, problems.join('\n')).toEqual([])
  })

  it('every reviewed exception states a reason', () => {
    for (const a of NOT_GATED) expect(a.reason.length, a.file).toBeGreaterThan(20)
  })
})
