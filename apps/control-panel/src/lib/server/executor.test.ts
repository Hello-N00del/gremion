// "Neuer Mandant" (Q6): the form is validated, board is refused by name, and
// gremion-tenant create is started with an argv -- one element per value, no
// shell -- as the signed-in operator. The start is WATCHED (review A-HIGH): a
// spawn failure is reported to the action (never an uncaught 'error' event
// that takes the panel down), and the child's output and exit code are logged.
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createArgv, spawnDetached, startCreate, validateNewCustomer, type NewCustomerInput, type SpawnLog, type Spawner } from './executor'

const OP = '5b8e0a52-2f9f-4b46-9e3a-0b5c7f1a2d33'
const good: NewCustomerInput = {
  slug: 'musterstadt',
  host: 'rat.musterstadt.example',
  itAdmin: 'IT@musterstadt.example',
  councilAdmin: 'rat@musterstadt.example',
  enable: ['publishing', 'calendar'],
  configFile: '/opt/gremion/etc/tenants/musterstadt.json',
}

function recorder(): SpawnLog & { lines: string[] } {
  const lines: string[] = []
  return { lines, info: (m) => void lines.push(`I ${m}`), error: (m) => void lines.push(`E ${m}`) }
}

describe('validateNewCustomer', () => {
  it('accepts a complete form', () => {
    expect(validateNewCustomer(good)).toEqual({})
  })

  it.each([
    ['slug', { slug: '1ab' }],
    ['slug', { slug: 'platform' }],
    ['slug', { slug: 'a--b' }],
    ['host', { host: 'Not A Host' }],
    ['itAdmin', { itAdmin: 'nope' }],
    ['councilAdmin', { councilAdmin: '' }],
    ['enable', { enable: ['board'] }],
    // R30 A1 (PRD-PLAT-012 / PRD-REC-003): the gate behind the panel denies vault by name too
    ['enable', { enable: ['vault'] }],
    ['enable', { enable: ['calendar', 'vault'] }],
    ['enable', { enable: ['calendar; rm -rf /'] }],
  ])('refuses a bad %s', (field, over) => {
    expect(Object.keys(validateNewCustomer({ ...good, ...over }))).toContain(field)
  })
})

describe('createArgv / startCreate', () => {
  it('builds one argv element per value, sorted modules, lower-cased emails, the operator id', () => {
    expect(createArgv(good, OP)).toEqual([
      'create',
      'musterstadt',
      '--host',
      'rat.musterstadt.example',
      '--config',
      '/opt/gremion/etc/tenants/musterstadt.json',
      '--it-admin',
      'it@musterstadt.example',
      '--council-admin',
      'rat@musterstadt.example',
      '--operator',
      OP,
      '--enable',
      'calendar,publishing',
    ])
  })

  it('refuses an operator id that is not a uuid', () => {
    expect(() => createArgv(good, 'root')).toThrow(/uuid/)
  })

  it('starts gremion-tenant through the spawner, never a shell string', async () => {
    const calls: [string, string[]][] = []
    const spawner: Spawner = async (cmd, argv) => {
      calls.push([cmd, argv])
      return { pid: 1, exited: Promise.resolve(0) }
    }
    await startCreate(good, OP, { spawner })
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe('gremion-tenant')
    expect(calls[0]![1][0]).toBe('create')
  })

  it('runs the resolved executable path when one is given', async () => {
    const calls: string[] = []
    await startCreate(good, OP, {
      command: '/usr/local/bin/gremion-tenant',
      spawner: async (cmd) => {
        calls.push(cmd)
        return { pid: 1, exited: Promise.resolve(0) }
      },
    })
    expect(calls).toEqual(['/usr/local/bin/gremion-tenant'])
  })

  it('a spawner that fails makes startCreate reject, so the action can show it', async () => {
    const spawner: Spawner = async () => {
      throw Object.assign(new Error('spawn gremion-tenant ENOENT'), { code: 'ENOENT' })
    }
    await expect(startCreate(good, OP, { spawner })).rejects.toThrow(/ENOENT/)
  })
})

describe('spawnDetached (the default spawner)', () => {
  it('a command that does not exist rejects with ENOENT and logs it; the process survives', async () => {
    const log = recorder()
    await expect(spawnDetached('t043-no-such-gremion-tenant', ['create'], 'musterstadt', log)).rejects.toMatchObject({ code: 'ENOENT' })
    // an unhandled 'error' event would surface as an uncaught exception here
    await new Promise((r) => setTimeout(r, 50))
    expect(log.lines.join('\n')).toMatch(/E .*musterstadt.*ENOENT/)
  })

  it('resolves once the child has started, keeps its output in the log and logs a non-zero exit code', async () => {
    const log = recorder()
    const started = await spawnDetached(
      process.execPath,
      ['-e', 'console.log("phase a: begin"); console.error("refused: slug taken"); process.exit(3)'],
      'musterstadt',
      log,
    )
    expect(started.pid).toBeGreaterThan(0)
    expect(await started.exited).toBe(3)
    const text = log.lines.join('\n')
    expect(text).toMatch(/I .*musterstadt.*phase a: begin/)
    expect(text).toMatch(/E .*musterstadt.*refused: slug taken/)
    expect(text).toMatch(/E .*musterstadt.*exit code 3/)
  })

  it('a SECOND error event on a running child (a failed kill) is logged, never an uncaught exception (r3 LOW)', async () => {
    const log = recorder()
    const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: null, stderr: null })
    const fakeSpawn = (() => {
      setImmediate(() => child.emit('spawn'))
      return child
    }) as unknown as typeof import('node:child_process').spawn
    const started = await spawnDetached('gremion-tenant', ['create'], 'musterstadt', log, fakeSpawn)
    expect(started.pid).toBe(4242)
    const kill = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    expect(() => child.emit('error', kill)).not.toThrow()
    expect(() => child.emit('error', kill)).not.toThrow()
    expect(log.lines.filter((l) => /ESRCH/.test(l))).toHaveLength(2)
    child.emit('close', 1, null)
    expect(await started.exited).toBeNull()
  })

  it('never copies a secret-looking output line into the log', async () => {
    const log = recorder()
    const started = await spawnDetached(process.execPath, ['-e', 'console.log("TEMPORARY-PASSWORD: hunter2hunter2")'], 'musterstadt', log)
    expect(await started.exited).toBe(0)
    expect(log.lines.join('\n')).not.toContain('hunter2hunter2')
  })
})
