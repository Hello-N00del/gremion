// apps/control-panel/src/lib/server/executor.ts — "Neuer Mandant" (FLOW-OPS-001
// A-D, Q6). The panel mutates nothing itself: with PANEL_EXECUTOR=gremion-tenant
// it starts `gremion-tenant create` (argv only, never a shell), whose phase A
// registers the customer's control row and pending ledger first; the status
// page then shows the ledger filling. With no executor the button is disabled
// and says why (newCustomerDisabledReason).
import { spawn } from 'node:child_process'

export interface NewCustomerInput {
  slug: string
  host: string
  itAdmin: string
  councilAdmin: string
  enable: string[]
  configFile: string
}

const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const MODULE = /^[a-z][a-z0-9_]*$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * Validates the form and returns the field errors (empty: valid). board (R29-I1)
 * and vault (PRD-PLAT-012 / PRD-REC-003, TASK-043c R30 A1) are refused by name,
 * as the interim enable gate behind `gremion-tenant create` refuses them.
 */
export function validateNewCustomer(input: NewCustomerInput): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!SLUG.test(input.slug) || input.slug.length < 3 || input.slug.length > 30 || input.slug === 'platform') {
    errors.slug = 'Kurzname: 3-30 Zeichen, a-z, 0-9 und einzelne Bindestriche, beginnend mit einem Buchstaben; nicht "platform".'
  }
  if (!HOST.test(input.host)) errors.host = 'Hostname in Kleinbuchstaben, z. B. rat.musterstadt.de.'
  if (!EMAIL.test(input.itAdmin.toLowerCase())) errors.itAdmin = 'E-Mail-Adresse der IT-Administration.'
  if (!EMAIL.test(input.councilAdmin.toLowerCase())) errors.councilAdmin = 'E-Mail-Adresse der Gremienverwaltung.'
  if (input.enable.some((m) => !MODULE.test(m))) errors.enable = 'Module als Kennungen, z. B. calendar.'
  else if (input.enable.includes('board')) errors.enable = 'board ist noch nicht mandantengetrennt und kann nicht aktiviert werden (R29-I1).'
  else if (input.enable.includes('vault')) errors.enable = 'vault (Tresor) bleibt im Pilotbetrieb abgeschaltet und kann nicht aktiviert werden (PRD-PLAT-012).'
  return errors
}

/** The argv of `gremion-tenant create` -- no shell, every value one element. */
export function createArgv(input: NewCustomerInput, operatorId: string): string[] {
  if (!UUID.test(operatorId)) throw new Error('the operator id is not a uuid')
  const argv = [
    'create',
    input.slug,
    '--host',
    input.host,
    '--config',
    input.configFile,
    '--it-admin',
    input.itAdmin.toLowerCase(),
    '--council-admin',
    input.councilAdmin.toLowerCase(),
    '--operator',
    operatorId,
  ]
  if (input.enable.length) argv.push('--enable', [...new Set(input.enable)].sort().join(','))
  return argv
}

export interface SpawnLog {
  info(msg: string): void
  error(msg: string): void
}

/** A started run: its pid and its exit code (null: killed by a signal or never started). */
export interface Started {
  pid: number
  exited: Promise<number | null>
}

/** Starts `cmd argv` and resolves once the child is running; rejects when it cannot start. */
export type Spawner = (cmd: string, argv: string[], tag: string) => Promise<Started>

const consoleLog: SpawnLog = {
  info: (m) => console.log(m),
  error: (m) => console.error(m),
}

// A line that looks like it carries a credential is never copied into the
// log (operator-add prints TEMPORARY-PASSWORD; create prints none today).
const SECRET_LINE = /(PASSWORD|SECRET|TOKEN)\s*[:=]/i

/**
 * The default spawner (review A-HIGH). The run is WATCHED: 'error' has a
 * listener from the start (an unhandled 'error' event on a ChildProcess is an
 * uncaught exception that ends the panel process); the promise settles on
 * 'spawn' (running) or 'error' (ENOENT, EACCES: the action shows it);
 * stdout/stderr go line by line into the panel's log, tagged with the slug;
 * the exit code is logged, a non-zero one at error level. Detached (its own
 * process group, so a signal to the panel's group does not reach it), but its
 * stdout/stderr are PIPES into the panel: when the panel exits or restarts,
 * the run dies on its next output line (EPIPE / SIGPIPE). That is recoverable
 * by design, not survived: every step is in the ledger, and a rerun of
 * `gremion-tenant create` resumes at the next step (review r2 LOW). The panel
 * keeps no per-run log file because its root filesystem is read-only.
 */
export function spawnDetached(cmd: string, argv: string[], tag: string, log: SpawnLog = consoleLog, spawnImpl: typeof spawn = spawn): Promise<Started> {
  return new Promise<Started>((resolve, reject) => {
    const prefix = `[control-panel] gremion-tenant ${tag}:`
    let settled = false
    let finish: (code: number | null) => void = () => {}
    const exited = new Promise<number | null>((r) => {
      let done = false
      finish = (code) => {
        if (done) return
        done = true
        r(code)
      }
    })
    let child: ReturnType<typeof spawn>
    try {
      child = spawnImpl(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: false })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      log.error(`${prefix} could not be started: ${e.code ?? ''} ${e.message}`)
      reject(err)
      return
    }
    // on, not once (r3 LOW): a later 'error' (a failed kill) must also find a
    // listener, or it is an uncaught exception that ends the panel.
    child.on('error', (err: NodeJS.ErrnoException) => {
      log.error(`${prefix} could not be started or failed: ${err.code ?? ''} ${err.message}`)
      finish(null)
      if (!settled) {
        settled = true
        reject(err)
      }
    })
    const pipe = (stream: NodeJS.ReadableStream | null, level: 'info' | 'error') => {
      if (!stream) return
      let buf = ''
      const emit = (line: string) => {
        if (!line) return
        log[level](`${prefix} ${SECRET_LINE.test(line) ? '[a line carrying a credential was withheld]' : line}`)
      }
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        buf += chunk
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          emit(buf.slice(0, i).replace(/\r$/, ''))
          buf = buf.slice(i + 1)
        }
      })
      stream.on('end', () => emit(buf))
    }
    pipe(child.stdout, 'info')
    pipe(child.stderr, 'error')
    child.once('spawn', () => {
      log.info(`${prefix} started (pid ${child.pid})`)
      if (!settled) {
        settled = true
        resolve({ pid: child.pid ?? 0, exited })
      }
    })
    // 'close' fires after stdout/stderr ended, so every output line is logged first.
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) log.info(`${prefix} exit code 0`)
      else log.error(`${prefix} exit code ${code ?? 'none'}${signal ? ` (signal ${signal})` : ''}`)
      finish(code)
    })
  })
}

export interface StartOptions {
  /** The resolved executable (config.resolveOnPath); default the bare name. */
  command?: string
  spawner?: Spawner
}

/** Starts `gremion-tenant create`; rejects when the executor cannot be started. */
export async function startCreate(input: NewCustomerInput, operatorId: string, opts: StartOptions = {}): Promise<string[]> {
  const argv = createArgv(input, operatorId)
  const spawner = opts.spawner ?? ((cmd, a, tag) => spawnDetached(cmd, a, tag))
  await spawner(opts.command ?? 'gremion-tenant', argv, `create ${input.slug} (operator ${operatorId})`)
  return argv
}
