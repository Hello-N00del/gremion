import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isWorkerGateOff, WORKER_GATE_DIR, _resetWorkerGateForTests } from './worker-gate'

// The worker gate: ONE small file per colour, read at the top of
// every background tick. The host writes `off` into runtime/workers/<colour>; the
// colour sees it read-only at /run/gremion/workers/<colour>. The contract is
// deliberately lopsided: ONLY the content `off` stops workers. An absent file, an
// absent directory, an empty file, an unreadable file and any other content mean ON,
// because an install that never ran CD has no file at all and must lose no worker.

let dir: string
let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'worker-gate-'))
  _resetWorkerGateForTests()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const gate = (colour = 'green') => isWorkerGateOff({ dir, colour })

describe('worker gate: what the file says', () => {
  it('the container path is the documented mount', () => {
    expect(WORKER_GATE_DIR).toBe('/run/gremion/workers')
  })

  it('content "off" is off, with or without trailing whitespace', async () => {
    writeFileSync(join(dir, 'green'), 'off')
    expect(await gate()).toBe(true)
    writeFileSync(join(dir, 'green'), 'off\n')
    expect(await gate()).toBe(true)
    writeFileSync(join(dir, 'green'), 'off \r\n')
    expect(await gate()).toBe(true)
  })

  it('an ABSENT file is ON (the default must never flip: it would stop every worker of an install that has no gate file)', async () => {
    mkdirSync(dir, { recursive: true })
    expect(await gate()).toBe(false)
  })

  it('an absent directory is ON', async () => {
    expect(await isWorkerGateOff({ dir: join(dir, 'does-not-exist'), colour: 'green' })).toBe(false)
  })

  it('an empty file is ON', async () => {
    writeFileSync(join(dir, 'green'), '')
    expect(await gate()).toBe(false)
  })

  it.each(['on', 'on\n', 'OFF', 'Off', 'offline', 'off!', 'false', '0', ' off', 'no', '{"off":true}'])(
    'any other content (%j) is ON',
    async (content) => {
      writeFileSync(join(dir, 'green'), content)
      expect(await gate()).toBe(false)
    },
  )

  it('only the first bytes count, like the host reader: a huge file of other content is ON', async () => {
    writeFileSync(join(dir, 'green'), 'x'.repeat(1_000_000))
    expect(await gate()).toBe(false)
  })

  it('an unreadable file is ON (a directory where the file should be cannot be read)', async () => {
    mkdirSync(join(dir, 'green'))
    expect(await gate()).toBe(false)
  })

  it('reads the file of ITS colour only', async () => {
    writeFileSync(join(dir, 'blue'), 'off')
    expect(await gate('green')).toBe(false)
    expect(await gate('blue')).toBe(true)
  })
})

describe('worker gate: the colour', () => {
  it.each(['', '../elsewhere', 'red', 'green/../blue', 'GREEN', 'blue\n', 'elsewhere'])(
    'a colour that is not blue or green (%j) is ON and reads nothing',
    async (colour) => {
      // Files that would say off wherever a bad colour could lead, one directory up included.
      const sub = join(dir, 'w')
      mkdirSync(sub)
      writeFileSync(join(dir, 'elsewhere'), 'off')
      writeFileSync(join(sub, 'elsewhere'), 'off')
      writeFileSync(join(sub, 'green'), 'off')
      writeFileSync(join(sub, 'blue'), 'off')
      expect(await isWorkerGateOff({ dir: sub, colour })).toBe(false)
    },
  )

  it('with no colour given the process COLOUR is used, read at call time', async () => {
    writeFileSync(join(dir, 'blue'), 'off')
    vi.stubEnv('COLOUR', 'blue')
    expect(await isWorkerGateOff({ dir })).toBe(true)
    vi.stubEnv('COLOUR', 'green')
    expect(await isWorkerGateOff({ dir })).toBe(false)
    vi.stubEnv('COLOUR', '')
    expect(await isWorkerGateOff({ dir })).toBe(false)
    vi.unstubAllEnvs()
  })
})

describe('worker gate: restart survival (nothing is cached in the process)', () => {
  it('the file is read on every call: a change between two ticks takes effect with no restart', async () => {
    writeFileSync(join(dir, 'green'), 'on')
    expect(await gate()).toBe(false)
    writeFileSync(join(dir, 'green'), 'off')
    expect(await gate()).toBe(true)
    writeFileSync(join(dir, 'green'), 'on')
    expect(await gate()).toBe(false)
    rmSync(join(dir, 'green'))
    expect(await gate()).toBe(false)
    writeFileSync(join(dir, 'green'), 'off')
    expect(await gate()).toBe(true)
  })

  it('a fresh process (module state reset) reads the same answer from the same file', async () => {
    writeFileSync(join(dir, 'green'), 'off')
    expect(await gate()).toBe(true)
    _resetWorkerGateForTests()
    expect(await gate()).toBe(true)
  })

  it('a reset between a tick that logged and the next one changes no decision', async () => {
    mkdirSync(join(dir, 'green'))
    expect(await gate()).toBe(false)
    _resetWorkerGateForTests()
    writeFileSync(join(dir, 'blue'), 'off')
    expect(await gate('blue')).toBe(true)
  })
})

describe('worker gate: logging', () => {
  it('an unreadable file logs ONCE per process, not once per tick', async () => {
    mkdirSync(join(dir, 'green'))
    for (let i = 0; i < 25; i++) expect(await gate()).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('[worker-gate]')
  })

  it('an absent file or directory never logs (it is the normal state of an install without CD)', async () => {
    for (let i = 0; i < 5; i++) await gate()
    for (let i = 0; i < 5; i++) await isWorkerGateOff({ dir: join(dir, 'nope'), colour: 'green' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('a change of state is said once, not once per tick (log output only, no decision reads it)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    writeFileSync(join(dir, 'green'), 'on')
    for (let i = 0; i < 5; i++) await gate()
    expect(info).not.toHaveBeenCalled() // on at start is the normal state: nothing to say
    writeFileSync(join(dir, 'green'), 'off')
    for (let i = 0; i < 25; i++) expect(await gate()).toBe(true)
    expect(info).toHaveBeenCalledTimes(1)
    writeFileSync(join(dir, 'green'), 'on')
    for (let i = 0; i < 5; i++) expect(await gate()).toBe(false)
    expect(info).toHaveBeenCalledTimes(2)
  })

  it('the log line carries the error class only, no path', async () => {
    mkdirSync(join(dir, 'green'))
    await gate()
    const line = String(warn.mock.calls[0]?.[0])
    expect(line).not.toContain(dir)
  })
})
