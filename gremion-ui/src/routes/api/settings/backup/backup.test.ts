// @vitest-environment node
//
// F1-FIX-10-K / H04 (D-4 = WIRE IT). The "Backup jetzt erstellen" button used to
// stamp last_backup_at and answer started:true with NOTHING started. These tests
// drive the route against a REAL listening socket that speaks gremion-hostd's
// protocol (one request line in, merged output lines, a final `EXIT <code>`),
// so every assertion is on the side effect: what hostd received, what run state
// was recorded, and when last_backup_at was written.
//
// Trigger contract: R29-F1-WAVE2/addendum.md ("D-4 trigger contract", KERNEL).
import net from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  hasRole: vi.fn(),
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  configPath: { value: '' },
}))

vi.mock('$env/dynamic/private', () => ({ env: h.env }))
vi.mock('$lib/auth', () => ({
  hasRole: h.hasRole,
  Role: { ITAdmin: 'it-admin', Member: 'member' },
}))
vi.mock('$lib/server/config', () => ({
  readConfig: h.readConfig,
  writeConfig: h.writeConfig,
}))
vi.mock('$lib/server/tenant/context', () => ({
  getTenant: () => ({ id: 'tenant-1', configPath: h.configPath.value }),
}))

type Reply = (sock: net.Socket, requestLine: string) => void

let tmpRoot = ''
let server: net.Server | null = null
let received: string[] = []
let sockSeq = 0

function socketPath(): string {
  // Windows has no unix sockets in the filesystem; a named pipe is the same
  // `net.connect(path)` call. Everywhere else the socket lives in tmpRoot.
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\gremion-f1-10-k-${process.pid}-${++sockSeq}`
    : join(tmpRoot, `hostd-${++sockSeq}.sock`)
}

async function startFakeHostd(reply: Reply): Promise<string> {
  const path = socketPath()
  received = []
  server = net.createServer((sock) => {
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const line = buf.slice(0, nl)
      received.push(line)
      buf = ''
      reply(sock, line)
    })
    sock.on('error', () => {})
  })
  await new Promise<void>((resolve) => server!.listen(path, resolve))
  return path
}

function makeLocals() {
  return { auth: async () => ({ user: { roles: ['it-admin'], email: 'it@example.org', preferred_username: 'it.admin' } }) }
}

async function loadRoute() {
  vi.resetModules()
  return import('./+server')
}

async function post(route: Awaited<ReturnType<typeof loadRoute>>) {
  const request = new Request('http://localhost/api/settings/backup', { method: 'POST' })
  // @ts-expect-error partial event
  return route.POST({ request, locals: makeLocals() })
}

async function get(route: Awaited<ReturnType<typeof loadRoute>>) {
  // @ts-expect-error partial event
  const res = await route.GET({ locals: makeLocals() })
  return (await res.json()) as {
    success: boolean
    data: unknown[]
    trigger: { available: boolean; reason?: string }
    run: null | { id: string; state: string; startedAt: string; finishedAt?: string; exitCode?: number | null }
    last_backup_at: string | null
  }
}

// A unix socket path is capped at ~108 bytes; a deep worktree under cwd overflows it,
// so the sockets (and run dirs) live under os.tmpdir() with a short prefix.
beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'gf-'))
})
afterAll(async () => {
  // The route records a run's end in the background once hostd's socket closes;
  // let that last write land before the directory goes, or it re-creates it.
  await new Promise((resolve) => setTimeout(resolve, 300))
  rmSync(tmpRoot, { recursive: true, force: true })
})

beforeEach(() => {
  for (const k of Object.keys(h.env)) delete h.env[k]
  h.env.BACKUP_RUNS_DIR = join(tmpRoot, `runs-${Math.random().toString(36).slice(2)}`)
  h.env.BACKUP_LOGS_DIR = join(tmpRoot, 'no-logs')
  h.configPath.value = join(tmpRoot, 'tenant', 'config.json')
  h.hasRole.mockReset().mockReturnValue(true)
  h.readConfig.mockReset().mockReturnValue({ backups: { retention_days: 30, last_backup_at: null, encryption_key_path: '' } })
  h.writeConfig.mockReset().mockReturnValue({})
})

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
  }
})

describe('POST /api/settings/backup (D-4: real trigger)', () => {
  it('refuses with 503 and the reason when hostd is unreachable: no fake started, no last_backup_at', async () => {
    h.env.GREMION_HOSTD_SOCKET = socketPath() // nothing listens here
    const route = await loadRoute()
    const res = await post(route)
    const body = await res.json()
    expect(res.status).toBe(503)
    expect(body.success).toBe(false)
    expect(String(body.error)).toMatch(/hostd/i)
    expect(body.data?.started).not.toBe(true)
    expect(h.writeConfig).not.toHaveBeenCalled()
    const status = await get(route)
    expect(status.run).toBeNull()
  })

  it('sends exactly the hostd verb `backup` and records started; last_backup_at is NOT written while it runs', async () => {
    let release: (() => void) | null = null
    h.env.GREMION_HOSTD_SOCKET = await startFakeHostd((sock) => {
      release = () => {
        sock.write('BACKUP-RESULT {"state":"finished","startedAt":"2026-10-01T10:00:00.000Z","finishedAt":"2026-10-01T10:05:00.000Z","exitCode":0}\n')
        sock.write('EXIT 0\n')
        sock.end()
      }
    })
    const route = await loadRoute()
    const res = await post(route)
    const body = await res.json()
    expect(res.status).toBe(202)
    expect(body.success).toBe(true)
    expect(body.data.state).toBe('started')
    expect(body.data.run_id).toBeTruthy()

    await vi.waitFor(() => expect(received).toEqual(['backup']))
    expect(h.writeConfig).not.toHaveBeenCalled()
    const running = await get(route)
    expect(running.run?.state).toBe('started')
    expect(running.run?.id).toBe(body.data.run_id)
    expect(running.trigger.available).toBe(true)

    release!()
    await vi.waitFor(async () => expect((await get(route)).run?.state).toBe('finished'))
    const done = await get(route)
    expect(done.run?.finishedAt).toBe('2026-10-01T10:05:00.000Z')
    expect(done.run?.exitCode).toBe(0)
    expect(h.writeConfig).toHaveBeenCalledTimes(1)
    expect(h.writeConfig.mock.calls[0]![0]).toEqual({ backups: { last_backup_at: '2026-10-01T10:05:00.000Z' } })
  })

  it('a failed run (non-zero EXIT) is recorded as failed and never stamps last_backup_at', async () => {
    h.env.GREMION_HOSTD_SOCKET = await startFakeHostd((sock) => {
      sock.write('BACKUP-RESULT {"state":"failed","startedAt":"2026-10-01T10:00:00.000Z","finishedAt":"2026-10-01T10:01:00.000Z","exitCode":1}\n')
      sock.write('EXIT 1\n')
      sock.end()
    })
    const route = await loadRoute()
    expect((await post(route)).status).toBe(202)
    await vi.waitFor(async () => expect((await get(route)).run?.state).toBe('failed'))
    expect((await get(route)).run?.exitCode).toBe(1)
    expect(h.writeConfig).not.toHaveBeenCalled()
  })

  it('EXIT 0 without a BACKUP-RESULT line still counts as finished, with our own finishedAt', async () => {
    h.env.GREMION_HOSTD_SOCKET = await startFakeHostd((sock) => {
      sock.write('hostd: some output\n')
      sock.write('EXIT 0\n')
      sock.end()
    })
    const route = await loadRoute()
    expect((await post(route)).status).toBe(202)
    await vi.waitFor(async () => expect((await get(route)).run?.state).toBe('finished'))
    expect(h.writeConfig).toHaveBeenCalledTimes(1)
    const stamped = h.writeConfig.mock.calls[0]![0].backups.last_backup_at as string
    expect(Number.isNaN(Date.parse(stamped))).toBe(false)
  })

  it('a BACKUP-RESULT that says failed wins over a zero EXIT', async () => {
    h.env.GREMION_HOSTD_SOCKET = await startFakeHostd((sock) => {
      sock.write('BACKUP-RESULT {"state":"failed","startedAt":"2026-10-01T10:00:00.000Z","finishedAt":"2026-10-01T10:01:00.000Z","exitCode":1}\n')
      sock.write('EXIT 0\n')
      sock.end()
    })
    const route = await loadRoute()
    expect((await post(route)).status).toBe(202)
    await vi.waitFor(async () => expect((await get(route)).run?.state).toBe('failed'))
    expect(h.writeConfig).not.toHaveBeenCalled()
  })

  it('a connection that drops without an EXIT line is a failed run, not a finished one', async () => {
    h.env.GREMION_HOSTD_SOCKET = await startFakeHostd((sock) => {
      sock.write('hostd: starting\n')
      sock.destroy()
    })
    const route = await loadRoute()
    expect((await post(route)).status).toBe(202)
    await vi.waitFor(async () => expect((await get(route)).run?.state).toBe('failed'))
    expect(h.writeConfig).not.toHaveBeenCalled()
  })

  it('refuses a second trigger while a run is in flight (409)', async () => {
    let release: (() => void) | null = null
    h.env.GREMION_HOSTD_SOCKET = await startFakeHostd((sock) => {
      release = () => {
        sock.write('EXIT 0\n')
        sock.end()
      }
    })
    const route = await loadRoute()
    expect((await post(route)).status).toBe(202)
    await vi.waitFor(() => expect(received).toEqual(['backup']))
    const second = await post(route)
    expect(second.status).toBe(409)
    expect(received).toEqual(['backup'])
    release!()
    await vi.waitFor(async () => expect((await get(route)).run?.state).toBe('finished'))
  })

  it('a run left in `started` by a dead process is reported failed (interrupted), never as running forever', async () => {
    let hold: net.Socket | null = null
    h.env.GREMION_HOSTD_SOCKET = await startFakeHostd((sock) => {
      hold = sock
    })
    const first = await loadRoute()
    expect((await post(first)).status).toBe(202)
    await vi.waitFor(() => expect(received).toEqual(['backup']))
    // A fresh module instance == a restarted process: it has no in-flight run.
    const restarted = await loadRoute()
    const status = await get(restarted)
    expect(status.run?.state).toBe('failed')
    expect(status.trigger.available).toBe(true)
    hold!.destroy()
    expect(h.writeConfig).not.toHaveBeenCalled()
  })

  it('403 for a non-IT-admin, and nothing is sent to hostd', async () => {
    h.hasRole.mockReturnValue(false)
    h.env.GREMION_HOSTD_SOCKET = await startFakeHostd((sock) => sock.end())
    const route = await loadRoute()
    expect((await post(route)).status).toBe(403)
    expect(received).toEqual([])
  })
})

describe('GET /api/settings/backup trigger availability', () => {
  it('reports available:false with a reason when the hostd socket is absent', async () => {
    h.env.GREMION_HOSTD_SOCKET = socketPath()
    const route = await loadRoute()
    const status = await get(route)
    expect(status.trigger.available).toBe(false)
    expect(status.trigger.reason).toMatch(/hostd/i)
  })

  it('reports available:true when the socket exists', async () => {
    h.env.GREMION_HOSTD_SOCKET = await startFakeHostd((sock) => sock.end())
    const route = await loadRoute()
    expect((await get(route)).trigger.available).toBe(true)
  })

  it('exposes last_backup_at from the config (only a finished run ever writes it)', async () => {
    h.env.GREMION_HOSTD_SOCKET = socketPath()
    h.readConfig.mockReturnValue({ backups: { retention_days: 30, last_backup_at: '2026-09-30T02:00:00.000Z', encryption_key_path: '' } })
    const route = await loadRoute()
    expect((await get(route)).last_backup_at).toBe('2026-09-30T02:00:00.000Z')
  })
})
