// T5: the scaffold CLI emits a service with NO route file; the scaffolded
// instance boots and its route table equals the spec (T1 on it). Also the
// routes:check CLI end to end against scaffolded services, including the
// brief's demo mutations (a hand-written extra route; an op removed from the
// spec), each of which must fail naming what is wrong.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { getRouteTable, PLATFORM_ROUTES, PROBLEM_CONTENT_TYPE, PROBLEM_TYPES, ServiceBootError } from '../src/index.ts'
import { scaffoldService } from '../src/scaffold.ts'
import { FIXTURE_ROUTE_KEYS, FIXTURE_SPEC_PATH, KERNEL_SPEC_PATH, PACKAGE_DIR } from './helpers.ts'

const TMP = join(PACKAGE_DIR, '.tmp', 'scaffold-test')
const PLATFORM_KEYS = PLATFORM_ROUTES.map((r) => `${r.method} ${r.path}`)
const ROUTE_REGISTRATION = /\b(fastify|app|instance|server|child|router)\s*\.\s*(get|post|put|patch|delete|head|options|all|route)\s*\(/

function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(relative(dir, p).split('\\').join('/'))
    }
  }
  walk(dir)
  return out.sort()
}

/** A private copy of the fixture spec + a service scaffolded from it. */
function scaffoldCase(name: string): { specPath: string; outDir: string } {
  const caseDir = join(TMP, name)
  mkdirSync(join(caseDir, 'spec'), { recursive: true })
  const specPath = join(caseDir, 'spec', 'widgets.openapi.json')
  copyFileSync(FIXTURE_SPEC_PATH, specPath)
  const outDir = join(caseDir, 'svc')
  const run = cli('scaffold.ts', ['--spec', specPath, '--out', outDir])
  expect(run.status, run.stderr).toBe(0)
  return { specPath, outDir }
}

function cli(script: string, args: string[]) {
  const r = spawnSync(process.execPath, [join(PACKAGE_DIR, 'src', 'cli', script), ...args], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, INIT_CWD: PACKAGE_DIR },
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}\n${r.stderr}` }
}

beforeAll(() => rmSync(TMP, { recursive: true, force: true }))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('T5: scaffold', () => {
  let outDir: string
  let app: FastifyInstance | undefined
  beforeAll(() => {
    ;({ outDir } = scaffoldCase('basic'))
  })
  afterAll(async () => {
    await app?.close()
  })

  it('emits package.json, src/index.ts and one 501 stub per operationId, and no route file', () => {
    expect(listFiles(outDir)).toEqual([
      'package.json',
      'src/handlers/createWidget.ts',
      'src/handlers/deleteWidget.ts',
      'src/handlers/getWidget.ts',
      'src/handlers/index.ts',
      'src/handlers/listWidgets.ts',
      'src/handlers/uploadFile.ts',
      'src/index.ts',
      'src/main.ts',
      'tsconfig.json',
    ])
    expect(listFiles(outDir).filter((f) => /route/i.test(f))).toEqual([])
    const manifest = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8'))
    expect(manifest.dependencies['@gremion/fastify-service-template']).toBe('workspace:*')
    expect(manifest.gremion.fastifyService).toEqual({ spec: '../spec/widgets.openapi.json', app: 'src/index.ts' })
  })

  it('no emitted file registers a route by hand (grep)', () => {
    const files = listFiles(outDir)
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      expect(readFileSync(join(outDir, f), 'utf8'), f).not.toMatch(ROUTE_REGISTRATION)
    }
  })

  it('emits LF line endings only', () => {
    for (const f of listFiles(outDir)) expect(readFileSync(join(outDir, f), 'utf8'), f).not.toContain('\r')
  })

  it('the scaffolded instance boots and its route table equals the spec (T1 on it)', async () => {
    const mod = await import(pathToFileURL(join(outDir, 'src', 'index.ts')).href)
    app = mod.buildApp() as FastifyInstance
    await app.ready()
    expect(getRouteTable(app).filter((k) => !PLATFORM_KEYS.includes(k)).sort()).toEqual(FIXTURE_ROUTE_KEYS)
    const res = await app.inject({ method: 'GET', url: '/widgets' })
    expect(res.statusCode).toBe(501)
    expect(res.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE)
    expect(res.json()).toMatchObject({ type: PROBLEM_TYPES.notImplemented, status: 501 })
    expect(res.json().detail).toContain('listWidgets')
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200)
  })

  it('refuses a non-empty output directory', () => {
    expect(() => scaffoldService({ spec: FIXTURE_SPEC_PATH, out: outDir })).toThrow(/not empty/)
  })

  it('refuses a spec createService would refuse (the kernel spec has no operationIds)', () => {
    expect(() => scaffoldService({ spec: KERNEL_SPEC_PATH, out: join(TMP, 'kernel-out') })).toThrow(ServiceBootError)
    expect(() => scaffoldService({ spec: KERNEL_SPEC_PATH, out: join(TMP, 'kernel-out') })).toThrow(/GET \/api\/health has no operationId/)
  })

  it('the CLI without --spec/--out exits 2 with usage', () => {
    const r = cli('scaffold.ts', ['--out', join(TMP, 'x')])
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/usage: scaffold/)
  })
})

describe('the template registers routes only in the loader (grep)', () => {
  it('no module under src/ other than loader.ts registers a route', () => {
    const srcDir = join(PACKAGE_DIR, 'src')
    const files = listFiles(srcDir).filter((f) => f.endsWith('.ts'))
    expect(files).toContain('loader.ts')
    const offenders = files.filter((f) => f !== 'loader.ts' && ROUTE_REGISTRATION.test(readFileSync(join(srcDir, f), 'utf8')))
    expect(offenders).toEqual([])
    expect(readFileSync(join(srcDir, 'loader.ts'), 'utf8')).toMatch(/app\.route\(/)
  })
})

describe('routes:check CLI on scaffolded services', () => {
  it('passes on a fresh scaffold', () => {
    const { outDir } = scaffoldCase('check-ok')
    const r = cli('routes-check.ts', ['--service', outDir])
    expect(r.status, r.out).toBe(0)
    expect(r.stdout).toMatch(/OK .*\(5 declared, 6 registered\)/)
  })

  it('demo: a hand-written app.get("/extra") fails, naming GET /extra', () => {
    const { outDir } = scaffoldCase('check-extra')
    const index = join(outDir, 'src', 'index.ts')
    const source = readFileSync(index, 'utf8').replace(
      '  return createService({ spec: SPEC_URL, handlers, config })\n',
      "  const app = createService({ spec: SPEC_URL, handlers, config })\n  app.get('/extra', async () => ({ hand: 'written' }))\n  return app\n",
    )
    expect(source).toContain("app.get('/extra'")
    writeFileSync(index, source)
    const r = cli('routes-check.ts', ['--service', outDir])
    expect(r.status, r.out).toBe(1)
    expect(r.stderr).toMatch(/extra route: GET \/extra is registered but not declared in the spec/)
  })

  // The services under services/ import workspace packages as SOURCE, and those use what tsc/esbuild
  // accept but Node's type STRIPPER refuses (enums, constructor parameter properties) and spell
  // relative imports by their OUTPUT name (`./x.js` for `./x.ts`). routes:check must boot such a
  // service as written; it used to die with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX the moment
  // services/kernel-api grew its first parameter property, failing the package script.
  it('boots a service whose source needs more than type erasure (enum, parameter property, tsc-style .js import)', () => {
    const { outDir } = scaffoldCase('check-needs-compile')
    writeFileSync(
      join(outDir, 'src', 'marker.ts'),
      ["export enum Colour {", "  Red = 'red',", "}", "", "export class Marker {", "  constructor(readonly colour: Colour) {}", "}", ""].join('\n'),
    )
    const index = join(outDir, 'src', 'index.ts')
    const source = readFileSync(index, 'utf8').replace(
      '  return createService({ spec: SPEC_URL, handlers, config })\n',
      '  void new Marker(Colour.Red)\n  return createService({ spec: SPEC_URL, handlers, config })\n',
    )
    expect(source).toContain('new Marker(Colour.Red)')
    writeFileSync(index, `import { Colour, Marker } from './marker.js'\n${source}`)
    const r = cli('routes-check.ts', ['--service', outDir])
    expect(r.status, r.out).toBe(0)
    expect(r.stdout).toMatch(/OK .*\(5 declared, 6 registered\)/)
  })

  it('demo: an operation removed from the spec fails, naming it', () => {
    const { specPath, outDir } = scaffoldCase('check-removed')
    const spec = JSON.parse(readFileSync(specPath, 'utf8'))
    delete spec.paths['/widgets/{widgetId}'].delete
    writeFileSync(specPath, JSON.stringify(spec, null, 2))
    const r = cli('routes-check.ts', ['--service', outDir])
    expect(r.status, r.out).toBe(1)
    expect(r.stderr).toMatch(/handler "deleteWidget" matches no operationId in the spec/)
  })

  it('a directory that is not a template service fails, it is not skipped', () => {
    const dir = join(TMP, 'not-a-service')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n')
    const r = cli('routes-check.ts', ['--service', dir])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/no gremion\.fastifyService\.spec descriptor/)
  })

  it('--self-check passes (the package script)', () => {
    const ok = cli('routes-check.ts', ['--self-check'])
    expect(ok.status, ok.out).toBe(0)
    expect(ok.stdout).toMatch(/OK template self-check .*\(5 declared, 6 registered\)/)
  })
})
