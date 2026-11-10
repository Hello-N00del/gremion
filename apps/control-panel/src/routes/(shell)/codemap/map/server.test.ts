// GET /codemap/map serves the generated page for the iframe: GET only, never cached, a plain 404 when there is no map.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ENV: Record<string, string | undefined> = {}
vi.mock('$env/dynamic/private', () => ({ env: ENV }))

const mod = await import('./+server')

const SHA = '0123456789abcdef0123456789abcdef01234567'
const status = (ok: boolean) => JSON.stringify({ ok, commit: SHA, generatedFor: 'x', counts: { functions: 1, connections: 1 }, staleSteps: [], staleAreas: [], undescribedAreas: [], reason: ok ? null : 'extract failed (exit 3)' })

describe('GET /codemap/map', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codemap-route-'))
    ENV.CODEMAP_DIR = dir
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
    delete ENV.CODEMAP_DIR
  })
  const get = () => mod.GET({} as never) as Promise<Response> | Response

  it('exports GET and nothing else that answers a request', () => {
    expect(Object.keys(mod).filter((k) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|fallback)$/.test(k))).toEqual(['GET'])
  })

  it('serves the page as html, utf-8, never cached', async () => {
    writeFileSync(join(dir, 'status.json'), status(true))
    writeFileSync(join(dir, 'code-map.html'), '<!doctype html><h1>map</h1>')
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).toBe('<!doctype html><h1>map</h1>')
  })

  it('no map file: 404 as plain text', async () => {
    writeFileSync(join(dir, 'status.json'), status(true))
    const res = await get()
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('a status of ok:false is 404 even when an html file is there', async () => {
    writeFileSync(join(dir, 'status.json'), status(false))
    writeFileSync(join(dir, 'code-map.html'), '<p>left over</p>')
    expect((await get()).status).toBe(404)
  })

  it('nothing at all: 404', async () => {
    expect((await get()).status).toBe(404)
  })
})
