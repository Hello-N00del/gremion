// pnpm --filter @gremion/fastify-service-template routes:check [--service <dir>]... [--self-check]
//
// Boots each template service, reads its ACTUAL route table (onRoute
// collector) and diffs it against the spec its descriptor names. Fail-closed:
// any extra, missing or duplicate route, a boot failure, a spec with 0
// operations, or 0 services checked at all exits 1.
//
// Targets: every --service <dir>; with no --service, every services/*/ whose
// package.json carries a gremion.fastifyService descriptor (the scaffold
// writes it). --self-check adds the template's own fixture service.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { FastifyInstance } from 'fastify'
import { checkAppRoutes } from '../routes-check.ts'
import { TEMPLATE_PACKAGE } from '../scaffold.ts'
import { createService, notImplemented } from '../service.ts'
import { listOperations, loadSpec, type OpenApiDocument } from '../spec.ts'

// A service imports the template by package name. Resolve that name to THIS
// source tree, so the check runs the template it ships with (and works for a
// service directory pnpm has not linked, e.g. a fresh scaffold).
// (`.ts` when run from source, `.js` when run from the built dist/.)
const SELF = new URL(import.meta.url.endsWith('.ts') ? '../index.ts' : '../index.js', import.meta.url).href

// A service is checked by importing its real entry point, and that import pulls in
// the workspace packages it depends on as SOURCE (`exports` -> src/*.ts). Node's
// default loader only ERASES types, and refuses the syntax that needs code (enums,
// namespaces, constructor parameter properties): `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.
// The services and several of those packages use that syntax freely, because
// esbuild/tsc/vite build them, and Node 26 has no transform mode (the
// --experimental-transform-types flag is gone). So the load hook below compiles
// TypeScript with the `typescript` package when the workspace has it, which loads
// the service as written rather than as the subset the stripper can read. Without
// `typescript` (a published copy of this package) nothing changes: Node strips.
let ts: typeof import('typescript') | null | undefined
function typescript(): typeof import('typescript') | null {
  if (ts === undefined) {
    try {
      ts = createRequire(import.meta.url)('typescript') as typeof import('typescript')
    } catch (e) {
      // only "there is no typescript here" falls back to the stripper; a typescript that is
      // present but fails to load (corrupt install, a missing dependency of its own) is an
      // error the operator must see, not a silent downgrade to the syntax subset
      if ((e as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND' || !/Cannot find module 'typescript'/.test((e as Error).message)) throw e
      ts = null
    }
  }
  return ts
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === TEMPLATE_PACKAGE) return { url: SELF, shortCircuit: true }
    try {
      return nextResolve(specifier, context)
    } catch (e) {
      // tsc's convention: a relative import names the OUTPUT file (`./x.js`) of the source `./x.ts`.
      if ((e as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\/.*\.js$/.test(specifier)) {
        try {
          return nextResolve(specifier.replace(/\.js$/, '.ts'), context)
        } catch (retry) {
          // neither file exists: report the specifier as the source wrote it, not our rewrite of it
          if ((retry as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') throw e
          throw retry
        }
      }
      throw e
    }
  },
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context)
    const module = loaded.format === 'module-typescript'
    if (!module && loaded.format !== 'commonjs-typescript') return loaded
    const compiler = typescript()
    if (!compiler || loaded.source == null) return loaded
    const { outputText } = compiler.transpileModule(typeof loaded.source === 'string' ? loaded.source : new TextDecoder().decode(loaded.source), {
      fileName: fileURLToPath(url),
      compilerOptions: {
        target: compiler.ScriptTarget.ESNext,
        module: module ? compiler.ModuleKind.ESNext : compiler.ModuleKind.CommonJS,
        verbatimModuleSyntax: module,
        sourceMap: false,
      },
    })
    return { ...loaded, format: module ? 'module' : 'commonjs', source: outputText }
  },
})

interface Target {
  label: string
  build: () => Promise<{ app: FastifyInstance; spec: OpenApiDocument }>
}

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error('cannot find the repository root (no pnpm-workspace.yaml above this file)')
    dir = parent
  }
  return dir
}

function readDescriptor(dir: string): { spec?: unknown; app?: unknown } | undefined {
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  return JSON.parse(readFileSync(manifestPath, 'utf8'))?.gremion?.fastifyService
}

function serviceTarget(dir: string): Target {
  return {
    label: dir,
    build: async () => {
      const descriptor = readDescriptor(dir)
      if (!descriptor || typeof descriptor.spec !== 'string') {
        throw new Error(`${join(dir, 'package.json')} has no gremion.fastifyService.spec descriptor`)
      }
      const appModule = typeof descriptor.app === 'string' ? descriptor.app : 'src/index.ts'
      const spec = loadSpec(resolve(dir, descriptor.spec))
      const mod = await import(pathToFileURL(resolve(dir, appModule)).href)
      if (typeof mod.buildApp !== 'function') throw new Error(`${appModule} exports no buildApp()`)
      return { app: await mod.buildApp(), spec }
    },
  }
}

function selfCheckTarget(): Target {
  const fixture = fileURLToPath(new URL('../../test/fixtures/widgets.openapi.json', import.meta.url))
  return {
    label: 'template self-check (test/fixtures/widgets.openapi.json)',
    build: async () => {
      const spec = loadSpec(fixture)
      const handlers = Object.fromEntries(
        listOperations(spec).map((op) => [op.operationId as string, notImplemented(op.operationId as string)]),
      )
      return { app: createService({ spec: fixture, handlers }), spec }
    },
  }
}

function parse(): { service?: string[]; 'self-check'?: boolean } {
  try {
    return parseArgs({
      options: { service: { type: 'string', multiple: true }, 'self-check': { type: 'boolean' } },
      strict: true,
    }).values
  } catch (e) {
    console.error(`[routes-check] ${(e as Error).message}`)
    process.exit(2)
  }
}

const values = parse()
const base = process.env.INIT_CWD ?? process.cwd()
const targets: Target[] = []
if (values.service?.length) {
  for (const s of values.service) targets.push(serviceTarget(resolve(base, s)))
} else {
  const servicesDir = join(repoRoot(), 'services')
  const dirs = existsSync(servicesDir) ? readdirSync(servicesDir).map((d) => join(servicesDir, d)) : []
  let found = 0
  for (const dir of dirs) {
    if (!existsSync(join(dir, 'package.json'))) continue
    if (readDescriptor(dir)) {
      targets.push(serviceTarget(dir))
      found++
    } else {
      console.log(`[routes-check] skipped ${dir}: no gremion.fastifyService descriptor (not a template service)`)
    }
  }
  console.log(`[routes-check] discovered ${found} template service(s) under ${servicesDir}`)
}
if (values['self-check']) targets.push(selfCheckTarget())

if (targets.length === 0) {
  console.error('[routes-check] FAILED: 0 services to check (vacuous); pass --service <dir> or --self-check')
  process.exit(1)
}

let failed = 0
for (const target of targets) {
  let problems: string[]
  let summary = ''
  let app: FastifyInstance | undefined
  try {
    const built = await target.build()
    app = built.app
    const result = await checkAppRoutes(built.app, built.spec)
    problems = result.problems
    summary = `${result.declared} declared, ${result.actual} registered`
  } catch (e) {
    problems = [`service failed to build: ${(e as Error).message}`]
  } finally {
    await app?.close().catch(() => undefined)
  }
  if (problems.length) {
    failed++
    console.error(`[routes-check] FAIL ${target.label}${summary ? ` (${summary})` : ''}:`)
    for (const p of problems) console.error(`  - ${p}`)
  } else {
    console.log(`[routes-check] OK ${target.label} (${summary})`)
  }
}
if (failed) {
  console.error(`[routes-check] FAILED: ${failed} of ${targets.length} service(s)`)
  process.exit(1)
}
console.log(`[routes-check] OK: ${targets.length} service(s), every route table equals its spec`)
