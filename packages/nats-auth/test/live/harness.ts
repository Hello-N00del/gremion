// The live-broker harness for scripts/proof.sh. NATS_AUTH_PROOF=open|auth
// names the broker under test; proof.sh starts it and passes where it is.
import { execFileSync } from 'node:child_process'
import { connect as netConnect } from 'node:net'
import { connect } from '@nats-io/transport-node'
import type { NatsConnection } from '@nats-io/nats-core'
import { fromSeed } from '@nats-io/nkeys'
import { expect } from 'vitest'
import { describeError } from './describe-error.ts'

export const MODE = (process.env.NATS_AUTH_PROOF ?? '') as 'open' | 'auth'
export const URL = process.env.NATS_AUTH_URL ?? ''
export const CONTAINER = process.env.NATS_AUTH_CONTAINER ?? ''
export const SECRETS = process.env.NATS_AUTH_SECRETS ?? ''
export const ACCOUNTS = process.env.NATS_AUTH_ACCOUNTS ?? ''
export const loc = { secretsDir: SECRETS }

if (!['open', 'auth'].includes(MODE) || !URL || !CONTAINER || !SECRETS || !ACCOUNTS) {
  throw new Error('[nats-auth-proof] run through packages/nats-auth/scripts/proof.sh (NATS_AUTH_PROOF/URL/CONTAINER/SECRETS/ACCOUNTS unset)')
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The monitor, read inside the container (it listens on the container's loopback). */
export function monitor<T = Record<string, unknown>>(p: string): T {
  return JSON.parse(execFileSync('docker', ['exec', CONTAINER, 'wget', '-qO-', `http://127.0.0.1:8222${p}`]).toString()) as T
}

export function containerState(): { id: string; startedAt: string; restarts: number } {
  const [id, startedAt, restarts] = execFileSync('docker', ['inspect', '-f', '{{.Id}} {{.State.StartedAt}} {{.RestartCount}}', CONTAINER]).toString().trim().split(' ')
  return { id: id!, startedAt: startedAt!, restarts: Number(restarts) }
}

export interface Conn {
  nc: NatsConnection
  /** Every async error the server sent this connection (-ERR text). */
  errors: string[]
}

export async function open(opts: Record<string, unknown> = {}): Promise<Conn> {
  const nc = await connect({ servers: URL, reconnect: false, timeout: 5_000, ...opts })
  const errors: string[] = []
  // Floating on purpose (it lives as long as the connection); describeError
  // never throws, and should the iterator itself fail, that failure is
  // RECORDED -- a refusal check then sees it, never a silent empty list.
  void (async () => {
    for await (const s of nc.status()) {
      const e = (s as { error?: unknown }).error
      if (s.type === 'error' && e) errors.push(describeError(e))
    }
  })().catch((err: unknown) => errors.push(`status loop failed: ${describeError(err)}`))
  return { nc, errors }
}

/**
 * A refusal is real only with a positive control first ON THE SAME
 * connection, and only when the server's own violation text arrives -- a
 * timeout, a closed connection or an API error is not a refusal. Returns what
 * the server said (asserted here to hold spec.text) for the test body to assert.
 */
export async function refused(c: Conn, spec: { control: () => Promise<unknown>; forbidden: () => Promise<unknown>; text: string }): Promise<string> {
  const start = c.errors.length
  await spec.control()
  await c.nc.flush()
  await sleep(100)
  expect(c.errors.slice(start), 'the positive control was itself refused').toEqual([])
  expect(c.nc.isClosed(), 'the positive control closed the connection').toBe(false)
  let thrown = ''
  try {
    await spec.forbidden()
    await c.nc.flush()
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err)
  }
  // status() delivers the -ERR asynchronously; it was sent before the PONG.
  for (let i = 0; i < 20 && !c.errors.slice(start).some((e) => e.includes(spec.text)) && !thrown.includes(spec.text); i++) await sleep(25)
  const seen = [...c.errors.slice(start), thrown].filter(Boolean)
  expect(seen.join('\n'), `want the server's "${spec.text}", got: ${seen.length ? seen.join(' | ') : 'nothing (the server accepted it)'}`).toContain(spec.text)
  return seen.join('\n')
}

/** A connect that must be refused with the server's Authorization Violation; returns the error text. */
export async function connectRefused(opts: Record<string, unknown>): Promise<string> {
  let err = ''
  try {
    const nc = await connect({ servers: URL, reconnect: false, timeout: 5_000, ...opts })
    await nc.close()
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }
  expect(err, 'the connection was accepted').toContain('Authorization Violation')
  return err
}

/**
 * A raw protocol client (no library in between): authenticates with a seed,
 * subscribes, and records every line the server sends and when the socket
 * closed. What the server says on eviction is read here verbatim.
 */
export async function rawClient(seed: Uint8Array, name: string, sub: string) {
  const u = new globalThis.URL(URL)
  const sock = netConnect({ host: u.hostname, port: Number(u.port) })
  let buf = ''
  const lines: string[] = []
  let closedAt: number | undefined
  sock.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\r\n')) >= 0) {
      lines.push(buf.slice(0, i))
      buf = buf.slice(i + 2)
    }
  })
  sock.on('close', () => (closedAt = Date.now()))
  sock.on('error', () => {})
  const waitLine = async (pred: (l: string) => boolean, ms: number) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const l = lines.find(pred)
      if (l) return l
      await sleep(20)
    }
    throw new Error(`no matching line within ${ms} ms; got ${JSON.stringify(lines.map((x) => x.slice(0, 80)))}`)
  }
  const info = JSON.parse((await waitLine((l) => l.startsWith('INFO '), 5_000)).slice(5)) as { nonce?: string }
  const kp = fromSeed(seed)
  const sig = info.nonce ? Buffer.from(kp.sign(new TextEncoder().encode(info.nonce))).toString('base64url') : undefined
  sock.write(`CONNECT ${JSON.stringify({ verbose: false, pedantic: false, protocol: 1, name, nkey: kp.getPublicKey(), sig })}\r\nSUB ${sub} 1\r\nPING\r\n`)
  await waitLine((l) => l === 'PONG' || l.startsWith('-ERR'), 5_000)
  return {
    lines,
    get closedAt() {
      return closedAt
    },
    waitLine,
    end: () => sock.destroy(),
  }
}
