// modules/files/test/download-stream.test.ts
// F1-FIX-03 / S4#0 (DOWNGRADED from HIGH) + K5#16: /api/v1/download piped the
// upstream body with Readable.fromWeb(body).pipe(res) and no error handler. When
// Nextcloud reset the connection mid-body, the Readable emitted 'error' with no
// listener: an uncaught exception that took the WHOLE files leaf down, for every
// user and tenant. The guard runs the real server in a CHILD process (an uncaught
// exception there is observable as an exit, not swallowed by the test runner),
// performs that download, and asserts the process is still alive and serving.
//
// Round 2 (review LOWs): the guard also proves the mid-body error path actually
// ran (status 200, then a truncated body, then the error-level log line with the
// error code, tenant and path), and that a CLIENT abort is logged at info level
// instead of as an upstream failure.
import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const moduleRoot = path.resolve(here, '..')
const harness = path.join(here, 'fixtures', 'stream-harness.ts')

const children: ChildProcess[] = []

afterEach(() => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null) c.kill()
  }
})

interface Harness {
  port: number
  proc: ChildProcess
  stdout: () => string
  stderr: () => string
}

function startHarness(): Promise<Harness> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', harness], {
      cwd: moduleRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(proc)
    let out = ''
    let err = ''
    proc.stderr!.on('data', (d: Buffer) => {
      err += d.toString()
    })
    proc.stdout!.on('data', (d: Buffer) => {
      out += d.toString()
      const line = out.split('\n').find((l) => l.startsWith('{'))
      if (line) {
        resolve({ port: (JSON.parse(line) as { port: number }).port, proc, stdout: () => out, stderr: () => err })
      }
    })
    proc.on('exit', (code) => reject(new Error(`harness exited early (${code}): ${err}`)))
    setTimeout(() => reject(new Error(`harness did not start: ${err}`)), 20_000).unref()
  })
}

const TENANT_ID = '11111111-1111-1111-1111-111111111111'

const HEADERS = {
  'content-type': 'application/json',
  'x-internal-auth': 'harness-secret',
  'x-tenant-id': TENANT_ID,
  'x-tenant-slug': 'alpha',
  'x-webdav-bearer': 'user-oidc-token',
}

/** Poll a log buffer for a marker (the child writes it asynchronously). */
async function waitFor(read: () => string, marker: string, until = Date.now() + 5_000): Promise<void> {
  if (read().includes(marker) || Date.now() >= until) return
  await new Promise((r) => setTimeout(r, 50))
  return waitFor(read, marker, until)
}

describe('files leaf download: an upstream error mid-body does not kill the process (S4#0, K5#16)', () => {
  it('the mid-body error path runs, is logged with code, tenant and path, and the leaf survives', async () => {
    const { port, proc, stderr } = await startHarness()
    const base = `http://127.0.0.1:${port}`
    const filePath = '/remote.php/dav/files/alice/report.pdf'

    // Headers were sent (200), then the body fails: the client sees a
    // truncated / aborted body. That is acceptable; the process dying is not.
    const res = await fetch(`${base}/api/v1/download`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ path: filePath, user: 'alice' }),
    })
    expect(res.status).toBe(200)
    // undici reports the cut-off body as "terminated".
    await expect(res.arrayBuffer()).rejects.toThrow(/terminated|closed|aborted|reset/i)

    // Positive proof that the S4#0/K5#16 path ran (not a 4xx before streaming).
    await waitFor(stderr, 'download stream failed mid-body')
    const log = stderr()
    expect(log).toContain('[files] download stream failed mid-body')
    expect(log).toContain('ECONNRESET')
    expect(log).toContain(TENANT_ID)
    expect(log).toContain(filePath)
    expect(log).not.toContain('user-oidc-token')

    // Give an uncaught exception time to surface as an exit.
    await new Promise((r) => setTimeout(r, 750))
    expect(proc.exitCode, `leaf exited; stderr: ${stderr()}`).toBeNull()

    const health = await fetch(`${base}/healthz`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })
    expect(proc.exitCode).toBeNull()
  }, 30_000)

  it('a client abort mid-download is logged at info level, not as an upstream failure', async () => {
    const { port, proc, stdout, stderr } = await startHarness()
    const base = `http://127.0.0.1:${port}`
    const filePath = '/remote.php/dav/files/alice/hang/big.pdf'

    const ac = new AbortController()
    const res = await fetch(`${base}/api/v1/download`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ path: filePath, user: 'alice' }),
      signal: ac.signal,
    })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    ac.abort()
    await reader.read().catch(() => undefined)

    await waitFor(stdout, 'download aborted by the client')
    expect(stdout()).toContain('[files] download aborted by the client')
    expect(stdout()).toContain(TENANT_ID)
    expect(stderr()).not.toContain('download stream failed mid-body')

    const health = await fetch(`${base}/healthz`)
    expect(health.status).toBe(200)
    expect(proc.exitCode).toBeNull()
  }, 30_000)
})
