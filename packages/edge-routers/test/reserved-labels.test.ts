import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, RESERVED_LABELS, deps, isReservedHost, APEX } from './helpers.js'
import { renderTenantRouter } from '../src/render.js'

// Q3: the package takes isReservedHost as a PARAMETER and never imports
// gremion-ui. The nine reserved names are pinned here as a fixture and
// cross-checked, as TEXT, against the module that owns them and the operator's
// RESERVED_HOSTS line, so a label added there and not here fails this suite.

function uiLabels(): string[] {
  const src = readFileSync(join(REPO_ROOT, 'gremion-ui', 'src', 'lib', 'server', 'tenant', 'reserved-hosts.ts'), 'utf8')
  const m = /RESERVED_PLATFORM_LABELS[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(src)
  expect(m, 'RESERVED_PLATFORM_LABELS literal found in reserved-hosts.ts').not.toBeNull()
  return [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!)
}

function envTmplLabels(): string[] {
  const src = readFileSync(join(REPO_ROOT, 'infra', 'host', 'templates', 'env', 'state.env.tmpl'), 'utf8')
  const line = src.split('\n').find((l) => l.startsWith('RESERVED_HOSTS='))
  expect(line, 'RESERVED_HOSTS= line in state.env.tmpl').toBeDefined()
  return line!.slice('RESERVED_HOSTS='.length).trim().split(/\s+/)
}

describe('reserved labels (Q3)', () => {
  it('the fixture holds eight labels (the apex is the ninth reserved name)', () => {
    expect(RESERVED_LABELS).toHaveLength(8)
    expect(new Set(RESERVED_LABELS).size).toBe(8)
  })

  it('equals gremion-ui RESERVED_PLATFORM_LABELS, in order', () => {
    expect(uiLabels()).toEqual(RESERVED_LABELS)
  })

  it('equals RESERVED_HOSTS in state.env.tmpl, in order', () => {
    expect(envTmplLabels()).toEqual(RESERVED_LABELS)
  })

  it('the emitter refuses all nine names through the injected predicate', () => {
    const nine = [APEX, ...RESERVED_LABELS.map((l) => `${l}.${APEX}`)]
    expect(nine).toHaveLength(9)
    const routable = nine.filter((h) => /^[a-z0-9.-]+$/.test(h)) // _dmarc is not a host at all
    const r = renderTenantRouter({ slug: 'acme', domains: nine.map((host) => ({ host })), ...deps })
    expect(r.yaml).toBeNull()
    expect(r.skipped.filter((s) => s.code === 'reserved').map((s) => s.host)).toEqual(routable)
    expect(r.skipped.filter((s) => s.code === 'invalid-host').map((s) => s.host)).toEqual([`_dmarc.${APEX}`])
    for (const h of routable) expect(isReservedHost(h)).toBe(true)
  })
})
