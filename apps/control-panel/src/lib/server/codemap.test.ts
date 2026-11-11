// The code map status the image build leaves in CODEMAP_DIR. A missing, empty or garbage file never throws: the
// page shows a notice and logs once.
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ENV: Record<string, string | undefined> = {}
vi.mock('$env/dynamic/private', () => ({ env: ENV }))
// the real fs, with readFileSync watched: the readability check of the map page must not read the file
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, readFileSync: vi.fn(real.readFileSync) }
})
const { readFileSync } = await import('node:fs')

const { readStatus, readMapHtml, checkMap, DEFAULT_DIR } = await import('./codemap')

const SHA = '0123456789abcdef0123456789abcdef01234567'
const okStatus = {
  ok: true,
  commit: SHA,
  generatedFor: 'Gremion kernel at ' + SHA,
  counts: { functions: 5486, connections: 11075 },
  staleSteps: [{ walkthrough: 'Sign-in', step: 3, file: 'a/b.ts', function: 'load', text: 'Old text.' }],
  staleAreas: ['area:gone@L3'],
  undescribedAreas: ['area:new@L3'],
  reason: null,
}

describe('codemap status', () => {
  let dir: string
  let errors: unknown[][]
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codemap-status-'))
    ENV.CODEMAP_DIR = dir
    errors = []
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
    delete ENV.CODEMAP_DIR
  })
  const put = (name: string, body: string) => writeFileSync(join(dir, name), body)

  it('the default folder is the runtime path of the image', () => {
    expect(DEFAULT_DIR).toBe('/app/codemap')
  })

  it('a missing status file is ok:false, commit unknown, a reason, logged once, no throw', () => {
    const s = readStatus()
    expect(s.ok).toBe(false)
    expect(s.commit).toBe('unknown')
    expect(s.reason).toMatch(/\S/)
    expect(s.staleSteps).toEqual([])
    expect(errors).toHaveLength(1)
  })

  it('a missing status file says it is missing, and the log line holds the error code', () => {
    const s = readStatus()
    expect(s.reason).toMatch(/fehlt/)
    expect(String(errors[0]?.[0])).toMatch(/ENOENT/)
  })

  it('an oversized status file is not reported as missing: it says too large, and logs that', () => {
    put('status.json', '')
    truncateSync(join(dir, 'status.json'), (1 << 20) + 1)
    const s = readStatus()
    expect(s).toMatchObject({ ok: false, commit: 'unknown' })
    expect(s.reason).toMatch(/zu groß/)
    expect(s.reason).not.toMatch(/fehlt|nicht vorhanden/)
    expect(errors).toHaveLength(1)
    expect(String(errors[0]?.[0])).toMatch(/too large/)
    expect(String(errors[0]?.[0])).not.toContain(dir)
  })

  it('a status file that cannot be read (a folder in its place) is not reported as missing: it says unreadable, and logs the real code', () => {
    mkdirSync(join(dir, 'status.json'))
    const s = readStatus()
    expect(s.ok).toBe(false)
    expect(s.reason).toMatch(/nicht gelesen/)
    expect(s.reason).not.toMatch(/fehlt|nicht vorhanden/)
    expect(errors).toHaveLength(1)
    expect(String(errors[0]?.[0])).toMatch(/\(E[A-Z]+\)/)
    expect(String(errors[0]?.[0])).not.toMatch(/ENOENT/)
    expect(String(errors[0]?.[0])).not.toContain(dir)
  })

  it('without CODEMAP_DIR it reads /app/codemap (which is not there here) and still does not throw', () => {
    delete ENV.CODEMAP_DIR
    expect(readStatus().ok).toBe(false)
  })

  it('garbage JSON is ok:false and logged once', () => {
    put('status.json', '{not json')
    const s = readStatus()
    expect(s).toMatchObject({ ok: false, commit: 'unknown' })
    expect(errors).toHaveLength(1)
  })

  it.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['ok as a string', JSON.stringify({ ...okStatus, ok: 'yes' })],
    ['a bad counts shape', JSON.stringify({ ...okStatus, counts: { functions: 'many' } })],
    ['stale steps that are not a list', JSON.stringify({ ...okStatus, staleSteps: 'x' })],
    ['a stale step with no text', JSON.stringify({ ...okStatus, staleSteps: [{ walkthrough: 'W', step: 1 }] })],
  ])('a wrong shape (%s) is ok:false', (_n, body) => {
    put('status.json', body)
    expect(readStatus()).toMatchObject({ ok: false, commit: 'unknown' })
    expect(errors).toHaveLength(1)
  })

  it('an ok status is returned typed, with the full commit and the stale lists', () => {
    put('status.json', JSON.stringify(okStatus))
    const s = readStatus()
    expect(s).toEqual(okStatus)
    expect(errors).toHaveLength(0)
  })

  it('an ok:false status from the image step keeps its commit and reason and is not an error to log', () => {
    put('status.json', JSON.stringify({ ...okStatus, ok: false, reason: 'extract timed out' }))
    const s = readStatus()
    expect(s).toMatchObject({ ok: false, commit: SHA, reason: 'extract timed out' })
    expect(errors).toHaveLength(0)
  })

  it('an ok:false status with no reason gets one, so the page can always say why', () => {
    put('status.json', JSON.stringify({ ok: false, commit: SHA }))
    const s = readStatus()
    expect(s.ok).toBe(false)
    expect(s.reason).toMatch(/\S/)
    expect(s.staleSteps).toEqual([])
  })

  it('a commit that is neither 40 hex characters nor "unknown" becomes unknown', () => {
    put('status.json', JSON.stringify({ ...okStatus, commit: '<script>alert(1)</script>' }))
    expect(readStatus().commit).toBe('unknown')
  })

  it('the map html is read from the fixed file name; a missing one is null', () => {
    expect(readMapHtml()).toBeNull()
    put('code-map.html', '<!doctype html><p>map</p>')
    expect(readMapHtml()).toBe('<!doctype html><p>map</p>')
  })

  it('a directory in place of the file is null, not a throw', () => {
    mkdirSync(join(dir, 'code-map.html'))
    expect(readMapHtml()).toBeNull()
  })
})

describe('codemap page check', () => {
  let dir: string
  let errors: unknown[][]
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codemap-map-'))
    ENV.CODEMAP_DIR = dir
    errors = []
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
    delete ENV.CODEMAP_DIR
  })

  it('a readable page is readable, nothing is logged, and the file is not read', () => {
    writeFileSync(join(dir, 'code-map.html'), '<p>map</p>')
    vi.mocked(readFileSync).mockClear()
    expect(checkMap()).toEqual({ readable: true, reason: null })
    expect(readFileSync).not.toHaveBeenCalled()
    expect(errors).toHaveLength(0)
  })

  it('a missing page is not readable, says so, and logs one line with the code', () => {
    const m = checkMap()
    expect(m.readable).toBe(false)
    expect(m.reason).toMatch(/fehlt/)
    expect(errors).toHaveLength(1)
    expect(String(errors[0]?.[0])).toMatch(/code-map.html.*ENOENT/)
    expect(String(errors[0]?.[0])).not.toContain(dir)
  })

  it('an oversized page is not readable, says too large, logs one line, and is not read', () => {
    writeFileSync(join(dir, 'code-map.html'), '')
    truncateSync(join(dir, 'code-map.html'), (32 << 20) + 1)
    vi.mocked(readFileSync).mockClear()
    const m = checkMap()
    expect(m).toMatchObject({ readable: false })
    expect(m.reason).toMatch(/zu groß/)
    expect(readFileSync).not.toHaveBeenCalled()
    expect(errors).toHaveLength(1)
    expect(String(errors[0]?.[0])).toMatch(/too large/)
  })

  it('a folder in place of the page is not readable, and logs one line', () => {
    mkdirSync(join(dir, 'code-map.html'))
    const m = checkMap()
    expect(m.readable).toBe(false)
    expect(m.reason).toMatch(/nicht gelesen/)
    expect(errors).toHaveLength(1)
  })
})
