// The scaffold: spec in, service out. It emits a handler stub per operationId
// and NO route file; routes are loaded from the spec at boot (loader.ts).
//
// Emitted (all LF, deterministic, no timestamps):
//   package.json               name, start script, the gremion.fastifyService
//                              descriptor routes:check discovers the service by
//   tsconfig.json
//   src/index.ts               buildApp(config) = createService({ spec, handlers, config })
//   src/main.ts                listens; reads UPLOAD_CEILING_BYTES / HOST / PORT
//   src/handlers/index.ts      the operationId -> handler table
//   src/handlers/<opId>.ts     one stub per operation: 501 problem+json
//
// The spec is REFERENCED (relative path), never copied: one committed spec
// stays the single source of truth for the service and for routes:check.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { ServiceBootError } from './errors.ts'
import { checkHandlerTable } from './loader.ts'
import { inlineRefs, listOperations, loadSpec, routeKey } from './spec.ts'

export interface ScaffoldOptions {
  /** Path to the committed OpenAPI 3.1 JSON spec. */
  spec: string
  /** Directory to create the service in. Must not exist or be empty. */
  out: string
  /** Package name suffix: `@gremion/<name>`. Default: the out directory's name. */
  name?: string
}

export interface ScaffoldResult {
  outDir: string
  /** Emitted files, relative to outDir, posix separators. */
  files: string[]
  operations: string[]
}

export const TEMPLATE_PACKAGE = '@gremion/fastify-service-template'

function posix(p: string): string {
  return p.split('\\').join('/')
}

function relativeSpecifier(fromDir: string, to: string): string {
  const rel = posix(relative(fromDir, to))
  return rel.startsWith('.') ? rel : `./${rel}`
}

/** A file-system-safe stub name for an operationId. */
export function handlerFileName(operationId: string): string {
  return operationId.replace(/[^A-Za-z0-9_-]/g, '_')
}

export function scaffoldService(options: ScaffoldOptions): ScaffoldResult {
  const specPath = resolve(options.spec)
  const outDir = resolve(options.out)
  const name = options.name ?? basename(outDir)
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new ServiceBootError([`service name ${JSON.stringify(name)} is not a valid npm package name segment`], 'cannot scaffold')
  }
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    throw new ServiceBootError([`${outDir} exists and is not empty; the scaffold never overwrites`], 'cannot scaffold')
  }

  // Refuse up front anything createService would refuse at boot.
  const doc = loadSpec(specPath)
  const ops = listOperations(inlineRefs(doc))
  if (ops.length === 0) throw new ServiceBootError([`${specPath} declares 0 operations`], 'cannot scaffold')
  const everyDeclared = Object.fromEntries(ops.flatMap((op) => (op.operationId ? [[op.operationId, () => undefined]] : [])))
  checkHandlerTable(ops, everyDeclared)

  const fileByOp = new Map<string, string>()
  const taken = new Map<string, string>()
  const clashes: string[] = []
  for (const op of ops) {
    const id = op.operationId as string
    const file = handlerFileName(id)
    const folded = file.toLowerCase()
    if (folded === 'index') clashes.push(`operationId "${id}" would overwrite handlers/index.ts`)
    const other = taken.get(folded)
    if (other) clashes.push(`operationIds "${other}" and "${id}" map to the same stub file ${file}.ts`)
    taken.set(folded, id)
    fileByOp.set(id, file)
  }
  if (clashes.length) throw new ServiceBootError(clashes, 'cannot scaffold')

  const specRel = posix(relative(outDir, specPath))
  const files: Record<string, string> = {}

  files['package.json'] =
    JSON.stringify(
      {
        name: `@gremion/${name}`,
        version: '0.0.0',
        private: true,
        license: 'AGPL-3.0-only',
        type: 'module',
        engines: { node: '>=22' },
        scripts: {
          start: 'node src/main.ts',
          typecheck: 'tsc --noEmit -p tsconfig.json',
        },
        dependencies: { [TEMPLATE_PACKAGE]: 'workspace:*' },
        devDependencies: { '@types/node': '26.6.0', typescript: '5.9.3' },
        gremion: { fastifyService: { spec: specRel, app: 'src/index.ts' } },
      },
      null,
      2,
    ) + '\n'

  files['tsconfig.json'] =
    JSON.stringify(
      {
        compilerOptions: {
          target: 'esnext',
          module: 'esnext',
          moduleResolution: 'bundler',
          lib: ['esnext'],
          types: ['node'],
          strict: true,
          skipLibCheck: true,
          verbatimModuleSyntax: true,
          isolatedModules: true,
          rewriteRelativeImportExtensions: true,
          erasableSyntaxOnly: true,
          noEmit: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ) + '\n'

  const header = `// Generated by ${TEMPLATE_PACKAGE} scaffold from ${specRel}.\n`
  files['src/index.ts'] =
    header +
    '//\n' +
    '// Routes come from the spec at boot. Do not register routes here: routes:check\n' +
    '// fails on any route the spec does not declare. Implement operations in\n' +
    '// src/handlers/, one file per operationId.\n' +
    `import { createService, type ServiceConfig } from '${TEMPLATE_PACKAGE}'\n` +
    `import { handlers } from './handlers/index.ts'\n\n` +
    `export const SPEC_URL = new URL(${JSON.stringify(relativeSpecifier(join(outDir, 'src'), specPath))}, import.meta.url)\n\n` +
    'export function buildApp(config: ServiceConfig = {}) {\n' +
    '  return createService({ spec: SPEC_URL, handlers, config })\n' +
    '}\n'

  files['src/main.ts'] =
    header +
    `import { buildApp } from './index.ts'\n\n` +
    '// UPLOAD_CEILING_BYTES unset = the 50 MiB platform default; an invalid value refuses to boot.\n' +
    'const app = buildApp({ uploadCeilingBytes: process.env.UPLOAD_CEILING_BYTES, logger: true })\n' +
    "await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? '3000') })\n"

  const imports: string[] = []
  const entries: string[] = []
  ops.forEach((op, i) => {
    const id = op.operationId as string
    const file = fileByOp.get(id) as string
    imports.push(`import h${i} from './${file}.ts'`)
    entries.push(`  ${JSON.stringify(id)}: h${i},`)
    files[`src/handlers/${file}.ts`] =
      header +
      `// operationId ${JSON.stringify(id)}: ${routeKey(op.method, op.path)}\n` +
      '//\n' +
      '// Answers 501 problem+json until implemented. Replace the default export with\n' +
      '// an OperationHandler: `export default (async (request, reply) => { ... }) satisfies OperationHandler`.\n' +
      `import { notImplemented } from '${TEMPLATE_PACKAGE}'\n\n` +
      `export default notImplemented(${JSON.stringify(id)})\n`
  })
  files['src/handlers/index.ts'] =
    header +
    '// The operationId -> handler table. createService refuses to boot if it and\n' +
    '// the spec disagree in either direction.\n' +
    `import type { HandlerTable } from '${TEMPLATE_PACKAGE}'\n` +
    imports.join('\n') +
    '\n\nexport const handlers: HandlerTable = {\n' +
    entries.join('\n') +
    '\n}\n'

  for (const [rel, content] of Object.entries(files)) {
    const target = join(outDir, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return {
    outDir,
    files: Object.keys(files).sort(),
    operations: ops.map((op) => `${op.operationId} ${routeKey(op.method, op.path)}`),
  }
}
