// TDD 3 — renderServerConfig() and the committed docker/nats/nats.conf.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createUser } from '@nats-io/nkeys'
import { describe, expect, test } from 'vitest'
import { renderServerConfig, type ServerState } from '../src/render.ts'

const REPO = path.resolve(import.meta.dirname, '../../..')
const NATS_CONF = readFileSync(path.join(REPO, 'docker/nats/nats.conf'), 'utf8')

const td = new TextDecoder()
const key = () => {
  const kp = createUser()
  return { pub: kp.getPublicKey(), seed: td.decode(kp.getSeed()) }
}
const sys = key()
const aAdmin = key(), aKernel = key(), aFinance = key()
const bAdmin = key(), bKernel = key()

const state = (): ServerState => ({
  sysReload: sys.pub,
  tenants: [
    { tenant: 'tb', admin: bAdmin.pub, modules: { kernel: bKernel.pub } },
    { tenant: 'ta', admin: aAdmin.pub, modules: { finance: aFinance.pub, kernel: aKernel.pub } },
  ],
})

/** The text of one `NAME { ... }` account block (brace-matched). */
function accountBlock(conf: string, name: string): string {
  const start = conf.search(new RegExp(`^\\s*${name} \\{`, 'm'))
  if (start < 0) throw new Error(`no account block ${name}`)
  let depth = 0
  for (let i = conf.indexOf('{', start); i < conf.length; i++) {
    if (conf[i] === '{') depth++
    if (conf[i] === '}' && --depth === 0) return conf.slice(start, i + 1)
  }
  throw new Error(`unbalanced block ${name}`)
}

describe('renderServerConfig (TDD 3)', () => {
  test('byte-stable: same state, any order, same bytes', () => {
    const s1 = state()
    const s2 = state()
    s2.tenants.reverse()
    s2.tenants[0]!.modules = { kernel: aKernel.pub, finance: aFinance.pub }
    expect(renderServerConfig(s1)).toBe(renderServerConfig(s2))
    expect(renderServerConfig(s1)).toBe(renderServerConfig(state()))
  })

  test('public keys only: no seed in the output', () => {
    const out = renderServerConfig(state())
    for (const k of [sys, aAdmin, aKernel, aFinance, bAdmin, bKernel]) {
      expect(out).toContain(k.pub)
      expect(out).not.toContain(k.seed)
    }
    expect(out).not.toMatch(/\bS[A-Z][A-Z2-7]{50,}/)
  })

  test('a seed passed where a public key belongs is refused', () => {
    const s = state()
    s.tenants[0]!.admin = bAdmin.seed
    expect(() => renderServerConfig(s)).toThrow(/not a user public key/)
  })

  test('no no_auth_user, no global authorization', () => {
    const out = renderServerConfig(state())
    expect(out).not.toMatch(/no_auth_user/)
    expect(out).not.toMatch(/^\s*authorization/m)
  })

  test('SYS only when there are no tenants', () => {
    const out = renderServerConfig({ sysReload: sys.pub, tenants: [] })
    expect(out).toMatch(/^\s*SYS \{/m)
    expect(out).not.toMatch(/T_/)
    expect(out).toContain(sys.pub)
  })

  test('tenants A and B never share an account block', () => {
    const out = renderServerConfig(state())
    const a = accountBlock(out, 'T_ta')
    const b = accountBlock(out, 'T_tb')
    for (const k of [aAdmin, aKernel, aFinance]) {
      expect(a).toContain(k.pub)
      expect(b).not.toContain(k.pub)
    }
    for (const k of [bAdmin, bKernel]) {
      expect(b).toContain(k.pub)
      expect(a).not.toContain(k.pub)
    }
    // bounded JetStream per tenant: one tenant cannot fill the server's store
    expect(a).toMatch(/jetstream: \{ max_mem: 8M, max_file: 512M, max_streams: 8, max_consumers: 64 \}/)
    expect(accountBlock(out, 'SYS')).not.toMatch(/jetstream/)
  })

  test('a NO_BROKER module gets no user; an unknown module is refused', () => {
    const s = state()
    s.tenants[0]!.modules.votes = key().pub
    expect(() => renderServerConfig(s)).toThrow(/votes .*NO_BROKER/)
  })

  test('the same public key twice is refused', () => {
    const s = state()
    s.tenants[0]!.modules.kernel = aKernel.pub
    expect(() => renderServerConfig(s)).toThrow(/used twice/)
  })
})

describe('docker/nats/nats.conf (TDD 3)', () => {
  const directives = NATS_CONF.split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean)
  test('no anonymous access: no no_auth_user, no global authorization', () => {
    expect(directives.join('\n')).not.toMatch(/no_auth_user/)
    expect(directives.join('\n')).not.toMatch(/^authorization/m)
  })
  test('system_account is SYS and the accounts file is included', () => {
    expect(directives).toContain('system_account: SYS')
    expect(directives).toContain('include ./accounts/accounts.conf')
  })
  test('the monitor is bound to loopback', () => {
    expect(directives).toContain('http: 127.0.0.1:8222')
    expect(directives.join('\n')).not.toMatch(/^(http_port|monitor_port|https?):?\s*(0\.0\.0\.0|\d+$)/m)
  })
  test('clients on 4222; JetStream stores under /data', () => {
    expect(directives).toContain('listen: 0.0.0.0:4222')
    expect(directives.join('\n')).toMatch(/store_dir: \/data/)
  })
})
