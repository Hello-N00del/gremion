// src/lib/server/tenant/worker-gate.ts
// The worker gate: one small file per colour, read at the top of every background tick.
//
// Two colours of the app tier can run side by side during a release (blue and green), and
// the background workers are safe in ONE process only (the provisioning mutex is in-process,
// the weekly mail would go out twice). The release tooling on the host therefore keeps the
// workers of exactly one colour on: it writes `off` into `runtime/workers/<colour>` for every
// other one. The directory is bind-mounted read-only, so this colour sees its own file at
// /run/gremion/workers/<COLOUR>.
//
// The contract is deliberately lopsided: ONLY the content `off` stops the workers. An absent
// file, an absent directory, an empty file, an unreadable file and any other content mean ON.
// An install that never ran the release tooling has no file at all and must lose no worker;
// a gate that failed closed would silently stop every tick of every install.
//
// It is a FILE and not an environment value on purpose: a container keeps the environment it
// was created with, so a value written into an env file would be lost on a restart-policy
// restart or a host reboot of the serving colour. The file survives both, and it is read on
// EVERY call, so a change between two ticks takes effect with no restart. Nothing about the
// decision is kept in the process.
//
// What it does not do: it gates background ticks, not requests, and a tick that is already
// running when the file turns `off` finishes. Background work that does not go through
// forEachActiveTenant (the event consumers, the leaf schedulers) is not gated; the static scan
// in worker-gate.scan.test.ts lists it with its reason.
import { open } from 'node:fs/promises'
import { join } from 'node:path'

/** Where the host's runtime/workers directory is mounted inside the container. */
export const WORKER_GATE_DIR = '/run/gremion/workers'

/** The host reader looks at the first 16 bytes only; so does this. */
const READ_BYTES = 16

/** The colours the release tooling knows. Anything else reads nothing and means ON. */
const COLOURS: ReadonlySet<string> = new Set(['blue', 'green'])

let _loggedUnreadable = false
let _lastLogged: 'on' | 'off' | null = null

interface GateOptions {
  /** Test seam: the directory of the gate files. */
  dir?: string
  /** Test seam: the colour. Default: the COLOUR of this process, read at call time. */
  colour?: string
}

/**
 * True when this colour's gate file says `off`. Never rejects, never caches: every call reads
 * the file again. See the file header for why every other outcome is ON.
 */
export async function isWorkerGateOff(opts: GateOptions = {}): Promise<boolean> {
  const colour = opts.colour ?? process.env.COLOUR ?? ''
  if (!COLOURS.has(colour)) return false
  const file = join(opts.dir ?? WORKER_GATE_DIR, colour)

  let content = ''
  try {
    const handle = await open(file, 'r')
    try {
      const buf = Buffer.alloc(READ_BYTES)
      const { bytesRead } = await handle.read(buf, 0, READ_BYTES, 0)
      content = buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close().catch(() => {})
    }
  } catch (err) {
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
    // An absent file or directory is the normal state of an install without the release
    // tooling: ON, quietly. Anything else (permissions, a directory in place of the file, an
    // I/O error) is also ON but is said once per process, never once per tick.
    if (code !== 'ENOENT' && code !== 'ENOTDIR' && !_loggedUnreadable) {
      _loggedUnreadable = true
      console.warn(
        `[worker-gate] the gate file cannot be read (${typeof code === 'string' ? code : 'error'}); workers stay on`,
      )
    }
    noteState('on')
    return false
  }

  // Trailing whitespace is ignored, exactly as the host reader does it.
  const off = content.replace(/\s+$/, '') === 'off'
  noteState(off ? 'off' : 'on')
  return off
}

/**
 * Says each change of state once. This is log output only: no decision ever reads it.
 */
function noteState(state: 'on' | 'off'): void {
  if (_lastLogged !== state) {
    if (_lastLogged !== null || state === 'off') {
      console.info(`[worker-gate] background workers of this colour are now ${state}`)
    }
    _lastLogged = state
  }
}

/** Test-only: forget the once-per-process logging state. */
export function _resetWorkerGateForTests(): void {
  _loggedUnreadable = false
  _lastLogged = null
}
