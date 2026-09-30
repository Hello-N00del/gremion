// modules/files/test/download-stream.test.ts
// F1-FIX-03 / S4#0 (DOWNGRADED from HIGH) + K5#16: /api/v1/download piped the
// upstream body with Readable.fromWeb(body).pipe(res) and no error handler. When
// Nextcloud reset the connection mid-body, the Readable emitted 'error' with no
// listener: an uncaught exception that took the WHOLE files leaf down, for every
// user and tenant. The guard runs the real server in a CHILD process (an uncaught
// exception there is observable as an exit, not swallowed by the test runner),
// performs that download, and asserts the process is still alive and serving.
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

function startHarness(): Promise<{ port: number; proc: ChildProcess; stderr: () => string }> {
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
      if (line) resolve({ port: (JSON.parse(line) as { port: number }).port, proc, stderr: () => err })
    })
    proc.on('exit', (code) => reject(new Error(`harness exited early (${code}): ${err}`)))
    setTimeout(() => reject(new Error(`harness did not start: ${err}`)), 20_000).unref()
  })
}

const HEADERS = {
  'content-type': 'application/json',
  'x-internal-auth': 'harness-secret',
  'x-tenant-id': '11111111-1111-1111-1111-111111111111',
  'x-tenant-slug': 'alpha',
  'x-webdav-bearer': 'user-oidc-token',
}

describe('files leaf download: an upstream error mid-body does not kill the process (S4#0, K5#16)', () => {
  it('the leaf survives, answers /healthz and serves the next request', async () => {
    const { port, proc, stderr } = await startHarness()
    const base = `http://127.0.0.1:${port}`

    // The download itself: headers were sent, then the body fails. The client
    // sees a truncated / aborted body; that is acceptable. The process dying is not.
    try {
      const res = await fetch(`${base}/api/v1/download`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ path: '/remote.php/dav/files/alice/report.pdf', user: 'alice' }),
      })
      await res.arrayBuffer()
    } catch {
      // An aborted download (reset / terminated) is the expected client view.
    }

    // Give an uncaught exception time to surface as an exit.
    await new Promise((r) => setTimeout(r, 750))
    expect(proc.exitCode, `leaf exited; stderr: ${stderr()}`).toBeNull()

    const health = await fetch(`${base}/healthz`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })
    expect(proc.exitCode).toBeNull()
  }, 30_000)
})
