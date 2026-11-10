#!/usr/bin/env node
// extract.mjs - builds a function-level call graph of the Gremion kernel repo and writes a graph file.
//
// Run:   node --max-old-space-size=3072 extract.mjs [--kernel <path>] [--out <file>] [--now]
//                                                  [--tree --commit <sha|unknown>] [--deps <dir>]
// Needs: Node 20+ and the `typescript` package. It is looked up in the kernel repo, then in --deps (a
//        folder with a node_modules, for example apps/control-panel), then in a .pnpm store of either.
//        `yaml` is optional and only used to list compose services; a missing yaml is not an error.
// Reads: git mode (default): the git-tracked files of the kernel repo (working tree content).
//        --tree mode: every file under the kernel folder except .git and node_modules, in sorted order,
//        with NO git call. The commit is the --commit value (or unknown); the commit date is empty.
//        This is how the container image runs it: the image has no git program and no history.
// Kernel folder: --kernel, else GREMION_KERNEL, else the repo that holds this file (three levels up).
// Writes: --out, else a folder under the system temp folder. Never inside the kernel repo (it refuses).
//        Deterministic: same tree gives byte-identical output (generatedAt is the commit date unless --now).
// Exit:  non-zero only for a crash or a graph with no nodes. A moved function never fails the run: the self
//        checks at the end are printed as information.
//
// Method (short): one TypeScript Program over all kept .ts files plus one virtual .ts file per .svelte
// script block (padded with blank lines so line numbers stay true). The type checker resolves each call
// site to a declaration; declarations that are function nodes become `calls` edges. Everything else
// (HTTP, SQL, NATS, page loads) is matched by string or by file convention, see the `kind` comments below.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/')
const argv = process.argv.slice(2)
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
// The default kernel folder is the repo this file is in: apps/control-panel/codemap/ is three levels down.
const KERNEL = (argOf('--kernel') ?? process.env.GREMION_KERNEL ?? path.resolve(HERE, '../../..')).replace(/\\/g, '/').replace(/\/$/, '')
const OUT = (argOf('--out') ?? path.join(os.tmpdir(), 'gremion-codemap', 'graph.json')).replace(/\\/g, '/')
const USE_NOW = argv.includes('--now')
const TREE = argv.includes('--tree')
const DEPS = argOf('--deps') ? path.resolve(argOf('--deps')).replace(/\\/g, '/').replace(/\/$/, '') : null
const COMMIT_ARG = argOf('--commit')
const t0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a)
const norm = (p) => p.replace(/\\/g, '/')
const lc = (s) => s.toLowerCase()

if (path.resolve(OUT).replace(/\\/g, '/').toLowerCase().startsWith(KERNEL.toLowerCase() + '/')) {
  console.error('refusing to write inside the kernel repo'); process.exit(2)
}

// ---------------------------------------------------------------------------------------------
// typescript + optional yaml, borrowed from the kernel repo or from --deps
// ---------------------------------------------------------------------------------------------
function loadFromKernel(mod) {
  const bases = [`${KERNEL}/gremion-ui/package.json`, `${KERNEL}/package.json`]
  if (DEPS) bases.push(`${DEPS}/package.json`)
  for (const b of bases) { try { return createRequire(b)(mod) } catch { /* try next */ } }
  // pnpm keeps every package in node_modules/.pnpm/<name>@<version>/node_modules/<name>
  for (const root of [KERNEL, DEPS]) {
    if (!root) continue
    const pnpm = `${root}/node_modules/.pnpm`
    try {
      const hit = fs.readdirSync(pnpm).find((d) => d.startsWith(`${mod}@`))
      if (hit) return createRequire(`${pnpm}/${hit}/node_modules/${mod}/package.json`)(mod)
    } catch { /* no store here, try the next */ }
  }
  return null
}
const ts = loadFromKernel('typescript')
if (!ts) { console.error('typescript not found (looked in the kernel folder and in --deps)'); process.exit(2) }
const YAML = loadFromKernel('yaml')
log('typescript', ts.version, YAML ? '(yaml found)' : '(yaml not found: compose files get no container list)')

// ---------------------------------------------------------------------------------------------
// git, or --tree: no git call at all
// ---------------------------------------------------------------------------------------------
const git = (...a) => execFileSync('git', a, { cwd: KERNEL, maxBuffer: 1 << 29, encoding: 'utf8' })
/** Every file under the kernel folder, relative, sorted. Skips .git and node_modules; follows no link. */
function walkTree(dir, rel = '') {
  const out = []
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name === '.git' || d.name === 'node_modules') continue
    const r = rel ? `${rel}/${d.name}` : d.name
    if (d.isDirectory()) out.push(...walkTree(`${dir}/${d.name}`, r))
    else if (d.isFile()) out.push(r)
  }
  return out
}
const cleanSha = (c) => (typeof c === 'string' && /^[0-9a-f]{40}$/.test(c) ? c : 'unknown')
const COMMIT = TREE ? cleanSha(COMMIT_ARG) : git('rev-parse', 'HEAD').trim()
const COMMIT_DATE = TREE ? '' : git('show', '-s', '--format=%cI', 'HEAD').trim()
const DIRTY = TREE ? false : git('status', '--porcelain', '--untracked-files=no').trim().length > 0
const TRACKED = TREE
  ? walkTree(KERNEL).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  : git('ls-files', '-z').split('\0').filter(Boolean).map(norm).filter((p) => fs.existsSync(`${KERNEL}/${p}`))
log(TREE ? 'tree mode' : 'git mode', 'commit', COMMIT.slice(0, 8), 'files', TRACKED.length, DIRTY ? '(working tree has tracked changes)' : '')

// ---------------------------------------------------------------------------------------------
// layers, areas, files
// ---------------------------------------------------------------------------------------------
const LAYERS = [
  ['L0', 'Servers and containers', 'Compose files, container build files, host scripts and cluster files. File nodes only.'],
  ['L1', 'Database', 'SQL migration files and the tables they create.'],
  ['L2', 'Shared packages', 'Libraries in packages/ that services and the web app import.'],
  ['L3', 'Backend services and module backends', 'Server programs in services/ and the backend of each module in modules/*/src.'],
  ['L4', 'Web server code', 'Server side of the web apps: hooks, +server.ts routes, load and action files, lib/server code.'],
  ['L5', 'Web pages', 'Svelte pages and components, and the browser-side code they use.'],
]
const nodes = new Map() // id -> node
const edgesMap = new Map() // key -> edge
const addNode = (n) => {
  if (nodes.has(n.id)) throw new Error('duplicate node id ' + n.id)
  const full = { id: n.id, kind: n.kind, name: n.name, parent: n.parent ?? null, file: n.file ?? '', line: n.line ?? 0, exported: !!n.exported, doc: n.doc ?? '', layer: n.layer ?? '' }
  nodes.set(n.id, full); return full
}
for (const [id, name, doc] of LAYERS) addNode({ id, kind: 'layer', name: `${id} ${name}`, doc, layer: id })

const areaNodes = new Map()
function area(layer, key, name, doc = '') {
  const id = `area:${key}@${layer}`
  if (!areaNodes.has(id)) { areaNodes.set(id, id); addNode({ id, kind: 'area', name, parent: layer, doc, layer }) }
  return id
}
const pkgNameCache = new Map()
function pkgJson(dir) {
  if (pkgNameCache.has(dir)) return pkgNameCache.get(dir)
  let v = null
  try { v = JSON.parse(fs.readFileSync(`${KERNEL}/${dir}/package.json`, 'utf8')) } catch { /* none */ }
  pkgNameCache.set(dir, v); return v
}

const EXCL_DIR = /(^|\/)(node_modules|build|dist|coverage|\.svelte-kit|test|tests|__tests__|fixtures|consumer-fixture|testing|generated|e2e|playwright-report)(\/|$)/
const EXCL_FILE = /(\.(test|spec)\.[cm]?[jt]s$)|(\.d\.ts$)|(\.config\.[cm]?[jt]s$)/
const NOT_INFRA = /\.(md|png|svg|ico|jpe?g|webp|gif|woff2?|ttf|pdf|txt|lock)$/i
const isExcluded = (p) => EXCL_DIR.test(p) || EXCL_FILE.test(p)

/** returns { kind:'ts'|'svelte'|'sql'|'infra', layer, areaId } or null */
function classify(p) {
  const base = p.split('/').pop()
  // L0
  let m
  if (/^docker-compose[^/]*\.ya?ml$/.test(p)) return { kind: 'infra', layer: 'L0', areaId: area('L0', 'docker-compose', 'Root docker-compose files', 'The compose files at the repo root. Each one lists containers.') }
  if ((m = p.match(/^(compose|docker|infra|k8s|ops)\/([^/]+)\//))) {
    if (EXCL_DIR.test(p) || NOT_INFRA.test(p) || /\.test\./.test(p)) return null
    const key = `${m[1]}/${m[2]}`
    return { kind: 'infra', layer: 'L0', areaId: area('L0', key, key, `Files under ${key}.`) }
  }
  if ((m = p.match(/^(compose|docker|infra|k8s|ops)\/[^/]+$/))) {
    if (NOT_INFRA.test(p)) return null
    return { kind: 'infra', layer: 'L0', areaId: area('L0', m[1], m[1], `Top-level files in ${m[1]}/.`) }
  }
  if (base === 'Dockerfile' || base.endsWith('.Dockerfile')) {
    const dir = path.posix.dirname(p)
    return { kind: 'infra', layer: 'L0', areaId: area('L0', `dockerfile:${dir}`, `${dir === '.' ? 'root' : dir} container build`, 'A Dockerfile builds the container image for this part.') }
  }
  if (isExcluded(p)) return null
  // L1: migrations
  if (p.endsWith('.sql')) {
    if (/(^|\/)(migrations[^/]*|platform-migrations|sql)\//.test(p)) {
      const dir = path.posix.dirname(p)
      return { kind: 'sql', layer: 'L1', areaId: area('L1', `db:${dir}`, `${dir} (SQL files)`, 'A folder of SQL files that build database tables.') }
    }
    return null
  }
  const isTs = /\.(ts|mts|cts)$/.test(p)
  const isSv = p.endsWith('.svelte')
  if (!isTs && !isSv) return null
  const kind = isSv ? 'svelte' : 'ts'
  // L2
  if ((m = p.match(/^packages\/([^/]+)\//))) {
    const pj = pkgJson(`packages/${m[1]}`)
    return { kind, layer: 'L2', areaId: area('L2', `packages/${m[1]}`, pj?.name ?? `packages/${m[1]}`, pj?.description ?? '') }
  }
  // L3
  if ((m = p.match(/^services\/([^/]+)\//))) {
    const pj = pkgJson(`services/${m[1]}`)
    return { kind, layer: 'L3', areaId: area('L3', `services/${m[1]}`, `${m[1]} service`, pj?.description ?? '') }
  }
  if ((m = p.match(/^modules\/([^/]+)\/(src|scripts)\//))) {
    const pj = pkgJson(`modules/${m[1]}`)
    return { kind, layer: 'L3', areaId: area('L3', `modules/${m[1]}`, `${m[1]} module backend`, pj?.description ?? '') }
  }
  // web apps
  let appKey = null, rel = null, appName = null
  if ((m = p.match(/^modules\/([^/]+)\/app\/(.+)$/))) { appKey = `modules/${m[1]}`; rel = m[2]; appName = `${m[1]} module` }
  else if ((m = p.match(/^gremion-ui\/src\/(.+)$/))) { appKey = 'gremion-ui'; rel = m[1]; appName = 'gremion-ui web app' }
  else if ((m = p.match(/^apps\/control-panel\/src\/(.+)$/))) { appKey = 'apps/control-panel'; rel = m[1]; appName = 'control-panel app' }
  else if ((m = p.match(/^gremion-public\/src\/(.+)$/))) { appKey = 'gremion-public'; rel = m[1]; appName = 'gremion-public site' }
  else if ((m = p.match(/^gremion-ui\/scripts\/(.+)$/))) { appKey = 'gremion-ui'; rel = 'scripts/' + m[1]; appName = 'gremion-ui web app' }
  if (appKey) {
    const l4 = isTs && (/(^|\/)lib\/server\//.test(rel) || /(^|\/)hooks\.server\.ts$/.test(rel) || rel.endsWith('.server.ts') || rel.startsWith('scripts/') ||
      (/(^|\/)routes\//.test(rel) && !/\+(page|layout)\.ts$/.test(rel)))
    const layer = l4 ? 'L4' : 'L5'
    return { kind, layer, areaId: area(layer, appKey, layer === 'L4' ? `${appName} server code` : `${appName} pages, components and shared client code`, layer === 'L4' ? 'Code that runs on the server.' : 'Svelte files and browser-side code.') }
  }
  return null
}

const files = [] // file infos
const fileByRel = new Map()
const fileByAbs = new Map()
for (const p of TRACKED) {
  const c = classify(p)
  if (!c) continue
  const fileId = `file:${p}`
  const fi = { rel: p, abs: `${KERNEL}/${p}`, fileId, ...c }
  let doc = ''
  if (c.kind === 'infra' && /(^|\/)docker-compose[^/]*\.ya?ml$/.test(p) && YAML) {
    try {
      const y = YAML.parse(fs.readFileSync(fi.abs, 'utf8'))
      const names = Object.keys(y?.services ?? {})
      if (names.length) doc = `Defines these containers: ${names.join(', ')}.`
    } catch { /* ignore unparsable */ }
  }
  addNode({ id: fileId, kind: 'file', name: path.posix.basename(p), parent: c.areaId, file: p, line: 1, doc, layer: c.layer })
  files.push(fi); fileByRel.set(p, fi); fileByAbs.set(lc(fi.abs), fi)
}
log('files kept', files.length, Object.fromEntries(['ts', 'svelte', 'sql', 'infra'].map((k) => [k, files.filter((f) => f.kind === k).length])))

// ---------------------------------------------------------------------------------------------
// tables from SQL
// ---------------------------------------------------------------------------------------------
const groupOf = (p) => {
  let m
  if ((m = p.match(/^(modules\/[^/]+)\//))) return m[1]
  if (p.startsWith('gremion-ui/')) return 'gremion-ui'
  if ((m = p.match(/^(services\/[^/]+)\//))) return m[1]
  if ((m = p.match(/^(packages\/[^/]+)\//))) return m[1]
  if ((m = p.match(/^(apps\/[^/]+)\//))) return m[1]
  if (p.startsWith('gremion-public/')) return 'gremion-public'
  return p.split('/')[0]
}
const tablesByName = new Map()
const stripQ = (s) => s.replace(/"/g, '')
for (const fi of files.filter((f) => f.kind === 'sql').sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
  const text = fs.readFileSync(fi.abs, 'utf8').replace(/\r\n/g, '\n')
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, ' ')).replace(/--[^\n]*/g, (s) => ' '.repeat(s.length))
  const re = /create\s+(?:unlogged\s+|temporary\s+|temp\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:"?[A-Za-z_][\w$]*"?\.)?"?[A-Za-z_][\w$]*"?)/gi
  let m
  while ((m = re.exec(noComments))) {
    const q = stripQ(m[1]); const parts = q.split('.'); const name = parts.pop(); const schema = parts.pop() ?? ''
    const line = noComments.slice(0, m.index).split('\n').length
    const id = `table:${fi.rel}#${q}`
    if (nodes.has(id)) continue
    addNode({ id, kind: 'table', name: q, parent: fi.fileId, file: fi.rel, line, exported: true, doc: '', layer: 'L1' })
    const arr = tablesByName.get(lc(name)) ?? []
    arr.push({ id, group: groupOf(fi.rel), schema, file: fi.rel }); tablesByName.set(lc(name), arr)
  }
}
log('tables', [...nodes.values()].filter((n) => n.kind === 'table').length)

// ---------------------------------------------------------------------------------------------
// svelte: virtual script files
// ---------------------------------------------------------------------------------------------
const VSUF = '.__script.ts'
const virtuals = new Map() // virtual abs path (lowercase key) -> text
const svelteInfo = new Map() // fi.rel -> { tplText, virtualAbs }
const lineOfOffset = (text, off) => { let n = 0; for (let i = 0; i < off; i++) if (text.charCodeAt(i) === 10) n++; return n }
for (const fi of files.filter((f) => f.kind === 'svelte')) {
  const text = fs.readFileSync(fi.abs, 'utf8').replace(/\r\n/g, '\n')
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g
  let m, v = '', cur = 0, any = false
  let tpl = text
  while ((m = re.exec(text))) {
    const contentStart = m.index + m[0].indexOf('>') + 1
    const target = lineOfOffset(text, contentStart)
    if (target > cur) { v += '\n'.repeat(target - cur); cur = target }
    v += m[2]; cur += (m[2].match(/\n/g) ?? []).length
    any = true
  }
  tpl = tpl.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, (s) => s.replace(/[^\n]/g, ' '))
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, (s) => s.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (s) => s.replace(/[^\n]/g, ' '))
  const info = { tplText: tpl, virtualAbs: null }
  if (any) { info.virtualAbs = fi.abs + VSUF; virtuals.set(lc(info.virtualAbs), v) }
  svelteInfo.set(fi.rel, info)
}

// ---------------------------------------------------------------------------------------------
// workspace packages + module resolution
// ---------------------------------------------------------------------------------------------
const workspace = new Map() // name -> { dir, pj }
for (const root of ['packages', 'modules', 'services', 'apps']) {
  const d = `${KERNEL}/${root}`
  if (!fs.existsSync(d)) continue
  for (const sub of fs.readdirSync(d)) {
    const pj = pkgJson(`${root}/${sub}`)
    if (pj?.name) workspace.set(pj.name, { dir: `${KERNEL}/${root}/${sub}`, pj })
  }
}
for (const sub of ['gremion-ui', 'gremion-public']) { const pj = pkgJson(sub); if (pj?.name) workspace.set(pj.name, { dir: `${KERNEL}/${sub}`, pj }) }

const existsCache = new Map()
const fexists = (p) => { const k = lc(p); if (virtuals.has(k)) return true; let v = existsCache.get(k); if (v === undefined) { try { v = fs.statSync(p).isFile() } catch { v = false } existsCache.set(k, v) } return v }
const pickExport = (v) => {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) { for (const x of v) { const r = pickExport(x); if (r) return r } return null }
  if (v && typeof v === 'object') { for (const k of ['import', 'default', 'types', 'node', 'require']) if (k in v) { const r = pickExport(v[k]); if (r) return r } }
  return null
}
function resolveWorkspace(spec) {
  const m = spec.match(/^(@[^/]+\/[^/]+)(\/.*)?$/)
  if (!m) return null
  const ws = workspace.get(m[1]); if (!ws) return null
  const sub = m[2] ? '.' + m[2] : '.'
  const ex = ws.pj.exports
  let target = null
  if (ex) {
    if (typeof ex === 'string' || Array.isArray(ex) || (ex && !Object.keys(ex).some((k) => k.startsWith('.')))) { if (sub === '.') target = pickExport(ex) }
    else if (sub in ex) target = pickExport(ex[sub])
    else { for (const k of Object.keys(ex)) { const star = k.indexOf('*'); if (star >= 0 && sub.startsWith(k.slice(0, star)) && sub.endsWith(k.slice(star + 1))) { const mid = sub.slice(star, sub.length - (k.length - star - 1)); const t = pickExport(ex[k]); if (t) target = t.replace('*', mid); break } } }
  } else if (sub === '.') target = ws.pj.module ?? ws.pj.main ?? './src/index.ts'
  else target = './src' + sub.slice(1)
  if (!target) return null
  const cands = [target, target.replace(/\/dist\//, '/src/').replace(/\.d\.ts$/, '.ts').replace(/\.js$/, '.ts'), target.replace(/\.js$/, '.ts')]
  for (const c of cands) { const abs = path.posix.join(ws.dir, c); if (fexists(abs)) return abs }
  return null
}
const modulesWithApp = () => fs.readdirSync(`${KERNEL}/modules`).filter((m) => fs.existsSync(`${KERNEL}/modules/${m}/app/lib`))
const MOD_APP_LIBS = modulesWithApp().map((m) => `${KERNEL}/modules/${m}/app/lib`)
function libRootsFor(cf) {
  const rel = cf.slice(KERNEL.length + 1)
  let m
  if ((m = rel.match(/^modules\/([^/]+)\/app\//))) return [`${KERNEL}/modules/${m[1]}/app/lib`, `${KERNEL}/gremion-ui/src/lib`, ...MOD_APP_LIBS]
  if (rel.startsWith('gremion-ui/')) return [`${KERNEL}/gremion-ui/src/lib`, ...MOD_APP_LIBS]
  if (rel.startsWith('apps/control-panel/')) return [`${KERNEL}/apps/control-panel/src/lib`]
  if (rel.startsWith('gremion-public/')) return [`${KERNEL}/gremion-public/src/lib`]
  return []
}
const mkRes = (abs) => ({ resolvedFileName: abs, extension: abs.endsWith('.tsx') ? '.tsx' : '.ts', isExternalLibraryImport: false })
const svelteVirtual = (abs) => (virtuals.has(lc(abs + VSUF)) ? mkRes(abs + VSUF) : undefined)
function tryFile(base) {
  if (base.endsWith('.svelte')) return svelteVirtual(base)
  const cands = []
  if (/\.[cm]?js$/.test(base)) cands.push(base.replace(/\.([cm]?)js$/, '.$1ts'))
  cands.push(base + '.ts', base + '.svelte.ts', base + '/index.ts', base)
  for (const c of cands) if (/\.[cm]?ts$/.test(c) && fexists(c)) return mkRes(c)
  return undefined
}
const realOf = (f) => (f.endsWith(VSUF) ? f.slice(0, -VSUF.length) : f)
const compilerOptions = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true, strict: true, esModuleInterop: true,
  resolveJsonModule: true, jsx: ts.JsxEmit.Preserve, types: ['node'],
  typeRoots: [`${KERNEL}/gremion-ui/node_modules/@types`], allowJs: false, noUnusedLocals: false,
}
const host = ts.createCompilerHost(compilerOptions, true)
const origGetSourceFile = host.getSourceFile.bind(host)
const origFileExists = host.fileExists.bind(host)
const origReadFile = host.readFile.bind(host)
host.getSourceFile = (fileName, langOrOpts, onError, shouldCreate) => {
  const v = virtuals.get(lc(norm(fileName)))
  if (v !== undefined) return ts.createSourceFile(fileName, v, langOrOpts, true, ts.ScriptKind.TS)
  return origGetSourceFile(fileName, langOrOpts, onError, shouldCreate)
}
host.fileExists = (f) => virtuals.has(lc(norm(f))) || origFileExists(f)
host.readFile = (f) => virtuals.get(lc(norm(f))) ?? origReadFile(f)
const unresolvedImports = new Map()
host.resolveModuleNames = (names, containingFile) => names.map((name) => {
  const cf = realOf(norm(containingFile))
  let r
  if (name === '$lib' || name.startsWith('$lib/')) {
    for (const root of libRootsFor(cf)) { r = tryFile(root + '/' + name.slice(5)); if (r) return r }
    unresolvedImports.set(name, (unresolvedImports.get(name) ?? 0) + 1); return undefined
  }
  if (name.startsWith('@gremion/')) { const w = resolveWorkspace(name); if (w) return mkRes(w) }
  if (name.startsWith('./') || name.startsWith('../') || name === '.' || name === '..') {
    if (cf.includes('/node_modules/')) return ts.resolveModuleName(name, cf, compilerOptions, host).resolvedModule
    const abs = path.posix.join(path.posix.dirname(cf), name)
    if (name.endsWith('.svelte')) { r = svelteVirtual(abs); if (!r) unresolvedImports.set(name, (unresolvedImports.get(name) ?? 0) + 1); return r }
  }
  if (name.startsWith('$app/') || name.startsWith('$env/') || name.startsWith('$service-worker') || name === '$types' || name.endsWith('/$types') || name.startsWith('$houdini')) return undefined
  const res = ts.resolveModuleName(name, cf, compilerOptions, host).resolvedModule
  if (res && res.resolvedFileName.endsWith('.svelte')) return undefined
  return res
})

// ---------------------------------------------------------------------------------------------
// program
// ---------------------------------------------------------------------------------------------
const codeFiles = files.filter((f) => f.kind === 'ts' || f.kind === 'svelte')
const rootNames = []
for (const fi of codeFiles) {
  if (fi.kind === 'ts') rootNames.push(fi.abs)
  else { const vi = svelteInfo.get(fi.rel).virtualAbs; if (vi) rootNames.push(vi) }
}
log('creating program with', rootNames.length, 'roots')
const program = ts.createProgram({ rootNames, options: compilerOptions, host })
const checker = program.getTypeChecker()
log('program ready')

const sfOf = new Map() // fi.rel -> sourceFile
const fiBySf = new Map()
for (const fi of codeFiles) {
  const name = fi.kind === 'ts' ? fi.abs : svelteInfo.get(fi.rel).virtualAbs
  if (!name) continue
  const sf = program.getSourceFile(name)
  if (!sf) { log('WARN no source file for', fi.rel); continue }
  sfOf.set(fi.rel, sf); fiBySf.set(sf, fi)
}
const relOfFileName = (fileName) => {
  const f = norm(fileName)
  if (lc(f).startsWith(lc(KERNEL) + '/')) return realOf(f).slice(KERNEL.length + 1)
  return null
}

// ---------------------------------------------------------------------------------------------
// helpers on the AST
// ---------------------------------------------------------------------------------------------
const unwrap = (e) => { while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression?.(e) || ts.isTypeAssertionExpression(e))) e = e.expression; return e }
const fnLike = (e) => !!e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e))
const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
const propName = (n) => (n && (ts.isIdentifier(n) || ts.isStringLiteralLike(n) || ts.isNumericLiteral(n) || ts.isPrivateIdentifier(n)) ? n.text : null)
const VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

function docOf(...hosts) {
  for (const h of hosts) {
    const docs = h?.jsDoc
    if (docs && docs.length) {
      const d = docs[docs.length - 1]
      const c = d.comment
      const t = typeof c === 'string' ? c : c ? ts.getTextOfJSDocComment(c) : ''
      let s = (t ?? '').replace(/\s+/g, ' ').trim()
      if (!s) continue
      const m = s.match(/^(.+?[.!?])(\s|$)/)
      if (m) s = m[1]
      return s.length > 240 ? s.slice(0, 237) + '...' : s
    }
  }
  return ''
}

// ---------------------------------------------------------------------------------------------
// pass 1: register function nodes
// ---------------------------------------------------------------------------------------------
const declToId = new Map() // ts.Node -> node id
const classToCtor = new Map() // ClassDeclaration -> ctor id
const classMembers = new Map() // ClassDeclaration -> Map(name -> id)
const fnNodesByFile = new Map() // rel -> [{id,name}]
const routeRecords = [] // {method, path, fi, line, handlerExpr, op, handlerId, sf}
const SPECIAL = new Set([...VERBS, 'load', 'handle', 'handleError', 'handleFetch', 'actions', 'entries'])
const allFnByName = new Map() // simple name -> [ids]

function registerSource(fi, sf) {
  const exportedNames = new Set()
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) for (const el of st.exportClause.elements) exportedNames.add((el.propertyName ?? el.name).text)
    if (ts.isExportAssignment(st) && ts.isIdentifier(st.expression)) exportedNames.add(st.expression.text)
  }
  const exportedFlag = (n) => !!(ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export)
  const list = fnNodesByFile.get(fi.rel) ?? []; fnNodesByFile.set(fi.rel, list)
  const used = new Map()

  function reg(keys, name, exported, docHosts, posNode) {
    const line = lineOf(sf, posNode)
    let id = `fn:${fi.rel}#${name}@${line}`
    const n = used.get(id) ?? 0; used.set(id, n + 1); if (n) id += `~${n}`
    addNode({ id, kind: 'function', name, parent: fi.fileId, file: fi.rel, line, exported, doc: docOf(...docHosts), layer: fi.layer })
    for (const k of keys) declToId.set(k, id)
    list.push({ id, name })
    const simple = name.split('.').pop().split(/\s/).pop()
    const arr = allFnByName.get(simple) ?? []; arr.push(id); allFnByName.set(simple, arr)
    return id
  }
  const isTop = (v) => { const p = v.parent?.parent?.parent; return !!p && (ts.isSourceFile(p) || ts.isModuleBlock(p)) }
  function objMembers(obj, prefix, exported, depth) {
    for (const p of obj.properties) {
      const nm = propName(p.name); if (nm == null) continue
      if (ts.isMethodDeclaration(p) && p.body) { if (!declToId.has(p)) reg([p], `${prefix}.${nm}`, exported, [p], p.name) }
      else if (ts.isPropertyAssignment(p)) {
        const init = unwrap(p.initializer)
        if (fnLike(init)) { if (!declToId.has(init)) reg([p, init], `${prefix}.${nm}`, exported, [p], p.name) }
        else if (ts.isObjectLiteralExpression(init) && depth < 3) objMembers(init, `${prefix}.${nm}`, exported, depth + 1)
      }
    }
  }
  const firstFn = (e, depth = 0) => {
    e = unwrap(e); if (!e) return null
    if (fnLike(e)) return e
    if (ts.isCallExpression(e) && depth < 3) { for (const a of e.arguments) { const r = firstFn(a, depth + 1); if (r) return r } }
    return null
  }
  const strOf = (e) => { e = unwrap(e); return e && ts.isStringLiteralLike(e) ? e.text : null }
  function routeShape(obj) {
    let method = null, p = null, handler = null, op = null
    for (const pr of obj.properties) {
      const nm = propName(pr.name); if (!ts.isPropertyAssignment(pr) && !ts.isMethodDeclaration(pr) && !ts.isShorthandPropertyAssignment(pr)) continue
      if (nm === 'method' && ts.isPropertyAssignment(pr)) method = strOf(pr.initializer)
      else if ((nm === 'path' || nm === 'url') && ts.isPropertyAssignment(pr)) p = strOf(pr.initializer)
      else if (nm === 'handler') handler = ts.isPropertyAssignment(pr) ? pr.initializer : ts.isMethodDeclaration(pr) ? pr : ts.isShorthandPropertyAssignment(pr) ? pr.name : null
      else if ((nm === 'op' || nm === 'operationId') && ts.isPropertyAssignment(pr)) op = strOf(pr.initializer)
    }
    if (!method || !p || !p.startsWith('/') || !(handler || op)) return null
    if (!VERBS.has(method.toUpperCase())) return null
    return { method: method.toUpperCase(), path: p, handler, op }
  }
  const inL34 = fi.layer === 'L3' || fi.layer === 'L4'

  function registerClass(cls, name, exported) {
    const members = new Map(); classMembers.set(cls, members)
    for (const m of cls.members) {
      if (ts.isConstructorDeclaration(m) && m.body) { const id = reg([m], `${name}.constructor`, exported, [m], m); classToCtor.set(cls, id); members.set('constructor', id) }
      else if (ts.isMethodDeclaration(m) && m.body) { const nm = propName(m.name); if (nm != null) members.set(nm, reg([m], `${name}.${nm}`, exported, [m], m.name)) }
      else if (ts.isPropertyDeclaration(m) && m.initializer && fnLike(unwrap(m.initializer))) { const nm = propName(m.name); if (nm != null) members.set(nm, reg([m, unwrap(m.initializer)], `${name}.${nm}`, exported, [m], m.name)) }
    }
  }

  function visit(n, enclosing) {
    if (ts.isTypeNode(n)) return
    if (ts.isFunctionDeclaration(n)) {
      if (n.body) {
        let name = n.name?.text ?? null
        if (!name && (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Default)) name = 'default'
        if (name) { reg([n], name, exportedFlag(n) || exportedNames.has(name), [n], n.name ?? n); enclosing = name }
      }
    } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      const nm = n.name.text
      const init = n.initializer ? unwrap(n.initializer) : null
      const top = isTop(n)
      const exp = exportedFlag(n) || exportedNames.has(nm)
      if (init && top && fnLike(init)) { reg([n, init], nm, exp, [n.parent.parent, n], n.name); enclosing = nm }
      else if (init && top && ts.isObjectLiteralExpression(init)) objMembers(init, nm, exp, 0)
      else if (init && top && SPECIAL.has(nm) && exp && !ts.isObjectLiteralExpression(init)) { reg([n], nm, exp, [n.parent.parent, n], n.name); enclosing = nm }
    } else if (ts.isClassDeclaration(n) && n.name) {
      registerClass(n, n.name.text, exportedFlag(n) || exportedNames.has(n.name.text))
    } else if (ts.isObjectLiteralExpression(n)) {
      if (inL34) {
        const shape = routeShape(n)
        if (shape) {
          const hf = shape.handler && !ts.isShorthandPropertyAssignment(shape.handler) && (ts.isMethodDeclaration(shape.handler) ? shape.handler : firstFn(shape.handler))
          let hid = null
          if (hf && !declToId.has(hf)) hid = reg([hf], `${shape.method} ${shape.path}`, true, [hf.parent], ts.isMethodDeclaration(hf) ? hf.name : (hf.parent && ts.isPropertyAssignment(hf.parent) ? hf.parent.name : hf))
          else if (hf) hid = declToId.get(hf)
          routeRecords.push({ method: shape.method, path: shape.path, fi, sf, line: lineOf(sf, n), handlerExpr: shape.handler && ts.isIdentifier(shape.handler) ? shape.handler : null, op: shape.op, handlerId: hid })
        }
      }
    } else if (ts.isCallExpression(n) && inL34 && ts.isPropertyAccessExpression(n.expression) && n.arguments.length >= 2) {
      const vb = n.expression.name.text
      const recv = ts.isIdentifier(n.expression.expression) ? n.expression.expression.text : ''
      const p = strOf(n.arguments[0])
      if (['get', 'post', 'put', 'patch', 'delete'].includes(vb) && p && p.startsWith('/') && /^(app|fastify|server|router|instance|api)$/.test(recv)) {
        const last = n.arguments[n.arguments.length - 1]
        const hf = firstFn(last)
        let hid = null
        if (hf && !declToId.has(hf)) hid = reg([hf], `${vb.toUpperCase()} ${p}`, true, [], hf)
        routeRecords.push({ method: vb.toUpperCase(), path: p, fi, sf, line: lineOf(sf, n), handlerExpr: ts.isIdentifier(unwrap(last)) ? unwrap(last) : null, op: null, handlerId: hid })
      }
    } else if (ts.isReturnStatement(n) && n.expression && enclosing) {
      const e = unwrap(n.expression)
      if (e && ts.isObjectLiteralExpression(e)) objMembers(e, enclosing, false, 0)
    }
    if (fnLike(n) && enclosing && n.body) {
      const b = unwrap(n.body)
      if (b && ts.isObjectLiteralExpression(b) && !ts.isBlock(n.body)) objMembers(b, enclosing, false, 0)
    }
    ts.forEachChild(n, (c) => visit(c, enclosing))
  }
  visit(sf, null)
}
for (const [, sf] of sfOf) registerSource(fiBySf.get(sf), sf)
// implementers index: interface symbol -> Map(member -> [ids])
log('function nodes', [...nodes.values()].filter((n) => n.kind === 'function').length)

// class/object implementers of interfaces (for calls through ports)
const implementers = new Map() // symbol -> Map(memberName -> Set(id))
function ifaceClosure(sym, out = new Set(), depth = 0) {
  if (!sym || out.has(sym) || depth > 6) return out
  out.add(sym)
  for (const d of sym.declarations ?? []) {
    if (ts.isInterfaceDeclaration(d) || ts.isClassDeclaration(d)) {
      for (const h of d.heritageClauses ?? []) for (const t of h.types) { let s = checker.getSymbolAtLocation(t.expression); if (s && (s.flags & ts.SymbolFlags.Alias)) s = checker.getAliasedSymbol(s); ifaceClosure(s, out, depth + 1) }
    }
  }
  return out
}
function addImpl(sym, member, id) {
  for (const s of ifaceClosure(sym)) { let m = implementers.get(s); if (!m) implementers.set(s, (m = new Map())); let set = m.get(member); if (!set) m.set(member, (set = new Set())); set.add(id) }
}
for (const [cls, members] of classMembers) {
  for (const h of cls.heritageClauses ?? []) {
    if (h.token !== ts.SyntaxKind.ImplementsKeyword) continue
    for (const t of h.types) {
      let s = checker.getSymbolAtLocation(t.expression); if (s && (s.flags & ts.SymbolFlags.Alias)) s = checker.getAliasedSymbol(s)
      if (s) for (const [mn, id] of members) addImpl(s, mn, id)
    }
  }
}
for (const [decl, id] of declToId) {
  // object literal members: PropertyAssignment / MethodDeclaration whose parent is an object literal with a contextual type
  const holder = decl.parent
  if (!holder || !ts.isObjectLiteralExpression(holder)) continue
  const mn = propName(decl.name); if (mn == null) continue
  let ct = null
  try { ct = checker.getContextualType(holder) } catch { ct = null }
  if (!ct) continue
  const types = ct.isUnion() ? ct.types : [ct]
  for (const t of types) { const s = t.aliasSymbol ?? t.symbol; if (s && s.name !== '__type' && s.name !== '__object') addImpl(s, mn, id); else if (t.aliasSymbol) addImpl(t.aliasSymbol, mn, id) }
}
log('implementer index', implementers.size)

// ---------------------------------------------------------------------------------------------
// pass 2: edges
// ---------------------------------------------------------------------------------------------
const stats = { resolved: 0, localClosure: 0, external: 0, excluded: 0, classNoCtor: 0, port: 0, unresolved: 0 }
const unresolvedReasons = new Map()
const portNames = new Map()
const eventSites = { publishCalls: 0, subscribeCalls: 0 }
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1)
function addEdge(from, to, kind, via = '') {
  if (!from || !to || from === to) return
  const key = `${from}|${to}|${kind}`
  const e = edgesMap.get(key)
  if (e) { e.n++; return }
  edgesMap.set(key, { from, to, kind, via, n: 1 })
}
const topNodes = new Map()
function topOf(fi) {
  if (fi.rel.endsWith('+page.svelte')) return pageIdOf(fi)
  let id = topNodes.get(fi.rel)
  if (!id) {
    const isSv = fi.kind === 'svelte'
    const nm = isSv ? `${path.posix.basename(fi.rel)} (component)` : '(module top level)'
    id = `fn:${fi.rel}#${isSv ? '<component>' : '<top-level>'}@0`
    addNode({ id, kind: 'function', name: nm, parent: fi.fileId, file: fi.rel, line: 1, exported: false, doc: isSv ? 'The Svelte component itself: script top level and template.' : 'Code that runs when this file loads.', layer: fi.layer })
    topNodes.set(fi.rel, id)
  }
  return id
}
const pageIds = new Map()
function pageIdOf(fi) {
  let id = pageIds.get(fi.rel)
  if (!id) { id = `page:${fi.rel}`; pageIds.set(fi.rel, id) }
  return id
}

const hasBodyFnLike = (d) => (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) && !!d.body
const isExternalFile = (fn) => { const f = norm(fn); return /\/node_modules\//.test(f) || /\/typescript\/lib\/lib\./.test(f) || !relOfFileName(f) }

/** resolve a symbol to repo function node ids; returns {ids, status} */
function targetsOfSymbol(sym) {
  if (!sym) return { ids: [], status: 'unresolved', reason: 'no symbol' }
  if (sym.flags & ts.SymbolFlags.Alias) { try { sym = checker.getAliasedSymbol(sym) } catch { return { ids: [], status: 'unresolved', reason: 'alias error' } } }
  const decls = sym.declarations ?? []
  if (!decls.length) return { ids: [], status: 'unresolved', reason: 'no declaration (unresolved import or any)' }
  const ids = []
  let sawPort = false, sawLocal = false, sawParam = false, sawExternal = false, sawExcluded = false, sawClass = false, sawVar = false
  for (const d of decls) {
    let id = declToId.get(d)
    if (!id && ts.isClassDeclaration(d)) { id = classToCtor.get(d); if (!id) sawClass = true }
    if (!id && ts.isShorthandPropertyAssignment(d)) { const vs = checker.getShorthandAssignmentValueSymbol(d); if (vs) { const r = targetsOfSymbol(vs); ids.push(...r.ids) } continue }
    if (id) { ids.push(id); continue }
    if ((ts.isMethodSignature(d) || ts.isPropertySignature(d)) && isExternalFile(d.getSourceFile().fileName)) { sawExternal = true; continue }
    if (ts.isMethodSignature(d) || ts.isPropertySignature(d)) {
      const holder = d.parent
      let hs = null
      if (ts.isInterfaceDeclaration(holder)) hs = holder.symbol
      else if (ts.isTypeLiteralNode(holder) && ts.isTypeAliasDeclaration(holder.parent)) hs = holder.parent.symbol
      const mn = propName(d.name)
      const set = hs && mn != null ? implementers.get(hs)?.get(mn) : null
      if (set && set.size) for (const x of set) ids.push(x); else sawPort = true
      continue
    }
    const sfn = d.getSourceFile().fileName
    if (isExternalFile(sfn)) { sawExternal = true; continue }
    const rel = relOfFileName(sfn)
    if (rel && !fileByRel.has(rel)) { sawExcluded = true; continue }
    if (ts.isParameter(d)) { sawParam = true; continue }
    if (ts.isVariableDeclaration(d) || ts.isBindingElement(d)) {
      const init = ts.isVariableDeclaration(d) && d.initializer ? unwrap(d.initializer) : null
      if (init && fnLike(init)) sawLocal = true; else sawVar = true
      continue
    }
    if (hasBodyFnLike(d) || (ts.isFunctionDeclaration(d))) { sawLocal = true; continue }
    sawVar = true
  }
  if (ids.length) return { ids: [...new Set(ids)], status: 'resolved' }
  if (sawExternal) return { ids: [], status: 'external' }
  if (sawExcluded) return { ids: [], status: 'excluded' }
  if (sawLocal) return { ids: [], status: 'localClosure' }
  if (sawClass) return { ids: [], status: 'classNoCtor' }
  if (sawPort) return { ids: [], status: 'port', reason: 'interface method with no implementer found' }
  if (sawParam) return { ids: [], status: 'unresolved', reason: 'callback parameter' }
  if (sawVar) return { ids: [], status: 'unresolved', reason: 'variable holding a function value' }
  return { ids: [], status: 'unresolved', reason: 'other' }
}

function calleeSymbol(callee) {
  callee = unwrap(callee)
  if (ts.isIdentifier(callee)) return checker.getSymbolAtLocation(callee)
  if (ts.isPropertyAccessExpression(callee)) return checker.getSymbolAtLocation(callee.name)
  if (ts.isElementAccessExpression(callee)) { const a = callee.argumentExpression; if (a && ts.isStringLiteralLike(a)) { const t = checker.getTypeAtLocation(callee.expression); return t.getProperty(a.text) } return undefined }
  return undefined
}
const rootIdentifier = (e) => { e = unwrap(e); while (e && (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e) || ts.isNonNullExpression(e))) e = unwrap(e.expression); return e && ts.isIdentifier(e) ? e : null }
const calleeName = (callee) => { callee = unwrap(callee); if (ts.isIdentifier(callee)) return callee.text; if (ts.isPropertyAccessExpression(callee)) return callee.name.text; return '' }

function resolveCall(call) {
  const callee = unwrap(call.expression)
  if (ts.isIdentifier(callee) && callee.text.startsWith('$')) return { ids: [], status: 'external' }
  if (fnLike(callee)) return { ids: [], status: 'iife' }
  if (callee.kind === ts.SyntaxKind.SuperKeyword || callee.kind === ts.SyntaxKind.ImportKeyword) return { ids: [], status: 'skip' }
  let sym
  try { sym = calleeSymbol(callee) } catch { sym = undefined }
  let r = targetsOfSymbol(sym)
  if (r.status === 'unresolved' && r.reason !== 'callback parameter') {
    // maybe an import that points outside the repo, or a call on a value of an external type
    const root = rootIdentifier(callee)
    if (root) {
      let rs = null; try { rs = checker.getSymbolAtLocation(root) } catch { rs = null }
      const rd = rs?.declarations?.[0]
      if (rd && (ts.isImportSpecifier(rd) || ts.isImportClause(rd) || ts.isNamespaceImport(rd))) {
        const decl = ts.findAncestor(rd, ts.isImportDeclaration)
        const spec = decl && ts.isStringLiteral(decl.moduleSpecifier) ? decl.moduleSpecifier.text : ''
        if (spec && !spec.startsWith('.') && !spec.startsWith('$lib') && !spec.startsWith('@gremion/')) return { ids: [], status: 'external' }
      }
    }
    // signature fallback
    try {
      const sig = checker.getResolvedSignature(call)
      const d = sig?.declaration
      if (d) {
        const id = declToId.get(d) ?? (ts.isFunctionLike(d) && d.parent && declToId.get(d.parent))
        if (id) return { ids: [id], status: 'resolved' }
        const sfn = d.getSourceFile().fileName
        if (isExternalFile(sfn)) return { ids: [], status: 'external' }
        const rel = relOfFileName(sfn)
        if (rel && !fileByRel.has(rel)) return { ids: [], status: 'excluded' }
        if (ts.isMethodSignature(d) || ts.isFunctionTypeNode(d) || ts.isCallSignatureDeclaration?.(d)) return { ids: [], status: 'port', reason: 'function type with no implementer found' }
      }
    } catch { /* ignore */ }
    r = { ...r, reason: r.reason ?? 'member call on untyped or unknown receiver' }
  }
  return r
}

// per-owner collectors
const sqlHits = [] // {owner, fi, tables:Set<string>}
const httpHits = [] // {owner, fi, path, method}
const pubHits = [] // {owner, subj}
const subHits = [] // {owner, pat}
const caseRoutes = [] // {fi, sf, path, owner, line}
const tmplCache = new Map()
const PH = '\u0001'

function pathOf(e, depth = 0) {
  e = unwrap(e); if (!e) return null
  if (ts.isStringLiteralLike(e)) return e.text
  if (ts.isTemplateExpression(e)) return e.head.text + e.templateSpans.map((s) => PH + s.literal.text).join('')
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = pathOf(e.left, depth + 1), r = pathOf(e.right, depth + 1)
    if (l == null && r == null) return null
    return (l ?? PH) + (r ?? PH)
  }
  if (ts.isCallExpression(e) && /^(encodeURIComponent|String|encodeURI)$/.test(calleeName(e.expression))) return PH
  if (ts.isIdentifier(e) && depth < 2) {
    let s = null; try { s = checker.getSymbolAtLocation(e) } catch { s = null }
    const d = s?.valueDeclaration
    if (d && ts.isVariableDeclaration(d) && d.initializer && (ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const)) return pathOf(d.initializer, depth + 1)
  }
  return null
}
function normPath(p) {
  if (p == null) return null
  p = p.replace(new RegExp(`^(${PH}[^/${PH}]*)+(?=/)`), '')
  if (!p.startsWith('/')) return null
  p = p.split(/[?#]/)[0].replace(/\/+$/, '')
  return p.length >= 2 ? p : null
}
function resolveExpr(e, depth = 0) {
  e = unwrap(e)
  if (!e || depth > 8) return e
  if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
    let sy; try { sy = checker.getSymbolAtLocation(ts.isIdentifier(e) ? e : e.name) } catch { sy = undefined }
    if (sy && (sy.flags & ts.SymbolFlags.Alias)) { try { sy = checker.getAliasedSymbol(sy) } catch { /* keep */ } }
    const d = sy?.valueDeclaration
    if (d && ts.isVariableDeclaration(d) && d.initializer) return resolveExpr(d.initializer, depth + 1)
    if (d && ts.isPropertyAssignment(d)) return resolveExpr(d.initializer, depth + 1)
    return e
  }
  if (ts.isElementAccessExpression(e) && e.argumentExpression && ts.isNumericLiteral(e.argumentExpression)) {
    const b = resolveExpr(e.expression, depth + 1)
    if (b && ts.isArrayLiteralExpression(b)) return resolveExpr(b.elements[Number(e.argumentExpression.text)], depth + 1)
  }
  return e
}
/** evaluate a string expression; unknown parts become * (a NATS single-token wildcard) */
function evalStr(e, depth = 0) {
  e = resolveExpr(e, depth)
  if (!e || depth > 8) return null
  if (ts.isStringLiteralLike(e)) return e.text
  if (ts.isTemplateExpression(e)) { let out = e.head.text; for (const sp of e.templateSpans) out += (evalStr(sp.expression, depth + 1) ?? '*') + sp.literal.text; return out }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) { const l = evalStr(e.left, depth + 1), r = evalStr(e.right, depth + 1); return l == null && r == null ? null : (l ?? '*') + (r ?? '*') }
  if (ts.isCallExpression(e)) {
    let sy; try { sy = calleeSymbol(e.expression) } catch { sy = undefined }
    if (sy && (sy.flags & ts.SymbolFlags.Alias)) { try { sy = checker.getAliasedSymbol(sy) } catch { /* keep */ } }
    const d = sy?.declarations?.find((x) => (ts.isFunctionDeclaration(x) || ts.isVariableDeclaration(x) || ts.isMethodDeclaration(x)))
    let fn = d && (ts.isVariableDeclaration(d) ? unwrap(d.initializer) : d)
    if (fn && (ts.isFunctionDeclaration(fn) || fnLike(fn) || ts.isMethodDeclaration(fn))) {
      const b = fn.body
      if (b && ts.isBlock(b)) { const rets = []; const w = (n) => { if (ts.isReturnStatement(n)) rets.push(n); if (!fnLike(n) && !ts.isFunctionDeclaration(n)) ts.forEachChild(n, w) }; b.statements.forEach(w); if (rets.length === 1 && rets[0].expression) return evalStr(rets[0].expression, depth + 1) }
      else if (b) return evalStr(b, depth + 1)
    }
  }
  return null
}
function subjectOf(e) {
  const v = evalStr(e)
  if (v != null) return v
  try { const t = checker.getTypeAtLocation(unwrap(e)); if (t.flags & ts.TypeFlags.StringLiteral) return t.value } catch { /* ignore */ }
  return null
}
const SQL_KW = /\b(select|insert|update|delete|truncate|create|alter|drop|with|copy|merge)\b/i
const SQL_FROM = /\b(from|into|update|join|table|truncate)\b/i
const SQL_TBL = /\b(?:from|join|into|update|truncate(?:\s+table)?|table(?:\s+if\s+(?:not\s+)?exists)?|references|delete\s+from)\s+(?:only\s+)?((?:"?[A-Za-z_][\w$]*"?\.)*"?[A-Za-z_][\w$]*"?)/gi
function sqlNames(text) {
  if (text.length < 10 || !SQL_KW.test(text) || !SQL_FROM.test(text)) return null
  const out = new Set(); let m; SQL_TBL.lastIndex = 0
  while ((m = SQL_TBL.exec(text))) { const q = stripQ(m[1]).split('.'); const name = lc(q[q.length - 1]); if (tablesByName.has(name)) out.add(name) }
  return out.size ? out : null
}
const HTTP_CALLEE = /^(fetch|request|call|send|get|post|put|patch|delete|head|GET|POST|PUT|PATCH|DELETE|HEAD)$|fetch|request|api[A-Z]|^api$|Json$/i
const FALSE_HTTP = /^(redirect|goto|resolve|join|resolveRoute|href|import|require|existsSync|readFile|readFileSync|path|resolvePath|navigate)$/

function isValuePos(n) {
  let c = n, p = n.parent
  while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isSatisfiesExpression?.(p))) { c = p; p = p.parent }
  if (!p) return false
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) return p.expression !== c
  if (ts.isPropertyAssignment(p)) return p.initializer === c
  if (ts.isShorthandPropertyAssignment(p)) return true
  if (ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p) || ts.isReturnStatement(p) || ts.isConditionalExpression(p)) return !ts.isConditionalExpression(p) || p.condition !== c
  if (ts.isBinaryExpression(p)) { const k = p.operatorToken.kind; return (k === ts.SyntaxKind.QuestionQuestionToken || k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.EqualsToken) && p.right === c }
  if (ts.isArrowFunction(p)) return p.body === c
  if (ts.isVariableDeclaration(p)) return p.initializer === c
  if (ts.isExportAssignment(p)) return true
  return false
}

let siteCount = 0
function processFile(fi, sf) {
  const fileTop = () => topOf(fi)
  const constSqlCache = tmplCache
  function visit(n, owner) {
    if (ts.isTypeNode(n) || ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return
    const own = declToId.get(n)
    if (own) owner = own
    const from = () => owner ?? fileTop()

    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      siteCount++
      let r
      if (ts.isNewExpression(n)) {
        let s; try { s = checker.getSymbolAtLocation(unwrap(n.expression).name ?? unwrap(n.expression)) ?? checker.getSymbolAtLocation(unwrap(n.expression)) } catch { s = undefined }
        r = targetsOfSymbol(s)
        if (r.status === 'resolved') { /* ok */ }
      } else r = resolveCall(n)
      if (r.status === 'resolved') { stats.resolved++; for (const id of r.ids) addEdge(from(), id, 'calls', 'call') }
      else if (r.status === 'iife' || r.status === 'skip') { /* not counted */ }
      else if (r.status === 'localClosure') stats.localClosure++
      else if (r.status === 'external') stats.external++
      else if (r.status === 'excluded') stats.excluded++
      else if (r.status === 'classNoCtor') stats.classNoCtor++
      else if (r.status === 'port') { stats.port++; bump(unresolvedReasons, 'port: ' + (r.reason ?? 'interface call')); bump(portNames, fi.rel.split('/').slice(0,2).join('/') + ' :: ' + (ts.isCallExpression(n) ? calleeName(n.expression) : 'new')) }
      else { stats.unresolved++; bump(unresolvedReasons, r.reason ?? 'other'); if (process.env.DEBUG_UNRES) console.log('UNRES', r.reason, fi.rel + ':' + lineOf(sf, n), n.expression.getText().slice(0, 70)) }

      if (ts.isCallExpression(n)) {
        const name = calleeName(n.expression)
        // http
        if (name && HTTP_CALLEE.test(name) && !FALSE_HTTP.test(name)) {
          const verb = VERBS.has(name.toUpperCase()) && /^(get|post|put|patch|delete|head)$/i.test(name) ? name.toUpperCase() : null
          let method = verb
          const args = n.arguments.slice(0, 3)
          for (const a of args) { const s = unwrap(a); if (s && ts.isStringLiteral(s) && VERBS.has(s.text.toUpperCase()) && s.text.length <= 7) method = method ?? s.text.toUpperCase(); if (s && ts.isObjectLiteralExpression(s)) for (const pr of s.properties) if (ts.isPropertyAssignment(pr) && propName(pr.name) === 'method') { const v = unwrap(pr.initializer); if (v && ts.isStringLiteralLike(v)) method = v.text.toUpperCase() } }
          if (!method && /fetch$/i.test(name)) method = 'GET'
          for (const a of args) {
            const p = normPath(pathOf(a))
            if (p) httpHits.push({ owner: from(), fi, path: p, method })
          }
        }
        // events
        if (process.env.DEBUG_EVENTS && /^(publish|publishEvent|subscribe|consume)$/.test(name)) console.log('EV', fi.rel, name, n.arguments[0]?.getText().slice(0,80), '=>', subjectOf(n.arguments[0]));
        if (/^(publish|publishEvent)$/.test(name)) eventSites.publishCalls++; if (/^(subscribe|consume)$/.test(name)) eventSites.subscribeCalls++
        if (/^(publish|publishEvent)$/.test(name) && n.arguments.length) { const s = subjectOf(n.arguments[0]); if (s && /^[\w*>-]+(\.[\w*>-]+)+$/.test(s)) pubHits.push({ owner: from(), subj: s }) }
        else if (/^(subscribe|consume|createConsumer|startConsumer|ensureConsumer|durableConsumer)$/.test(name)) {
          for (const a of n.arguments) {
            const u = unwrap(a)
            if (u && ts.isObjectLiteralExpression(u)) { for (const pr of u.properties) if (ts.isPropertyAssignment(pr) && /^(filterSubject|filter_subject|subject)$/.test(propName(pr.name) ?? '')) { const s = subjectOf(pr.initializer); if (s) subHits.push({ owner: from(), pat: s }) } }
          }
          if (n.arguments.length) { const s = subjectOf(n.arguments[0]); if (s && /^[\w*>-]+(\.[\w*>-]+)*$/.test(s)) subHits.push({ owner: from(), pat: s }) }
        }
      }
    } else if (ts.isCaseClause(n) && (fi.layer === 'L3') && ts.isStringLiteralLike(n.expression) && n.expression.text.startsWith('/') && n.expression.text.length > 2) {
      caseRoutes.push({ fi, sf, path: n.expression.text, owner: from(), line: lineOf(sf, n) })
    } else if (ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) {
      const text = ts.isTemplateExpression(n) ? n.head.text + ' ' + n.templateSpans.map((s) => s.literal.text).join(' ') : n.text
      const names = sqlNames(text)
      if (names) sqlHits.push({ owner: from(), fi, names })
    } else if (ts.isIdentifier(n) && /^[A-Z][A-Z0-9_]{3,}$|SQL|Sql|QUERY|Query|STATEMENT/.test(n.text) && owner && !(n.parent && (ts.isVariableDeclaration(n.parent) && n.parent.name === n))) {
      let s; try { s = checker.getSymbolAtLocation(n) } catch { s = undefined }
      const d = s?.valueDeclaration
      if (d && ts.isVariableDeclaration(d) && d.initializer && (ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) && d.getSourceFile() === sf) {
        let c = constSqlCache.get(d)
        if (c === undefined) { const e = unwrap(d.initializer); const text = e && ts.isStringLiteralLike(e) ? e.text : e && ts.isTemplateExpression(e) ? e.head.text + ' ' + e.templateSpans.map((x) => x.literal.text).join(' ') : ''; c = text ? sqlNames(text) : null; constSqlCache.set(d, c) }
        if (c) sqlHits.push({ owner, fi, names: c })
      }
    }

    // reference edges: a repo function passed or stored as a value
    if ((ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) && n.parent && !ts.isTypeReferenceNode(n.parent) && isValuePos(n)) {
      const simple = ts.isIdentifier(n) ? n.text : n.name.text
      if (allFnByName.has(simple) || (ts.isShorthandPropertyAssignment(n.parent) && allFnByName.has(simple))) {
        let s; try { s = ts.isShorthandPropertyAssignment(n.parent) ? checker.getShorthandAssignmentValueSymbol(n.parent) : checker.getSymbolAtLocation(ts.isIdentifier(n) ? n : n.name) } catch { s = undefined }
        if (s) { const r = targetsOfSymbol(s); if (r.status === 'resolved') for (const id of r.ids) addEdge(from(), id, 'calls', 'ref') }
      }
    }
    ts.forEachChild(n, (c) => visit(c, owner))
  }
  visit(sf, null)
}
for (const [, sf] of sfOf) processFile(fiBySf.get(sf), sf)
log('call sites', siteCount, JSON.stringify(stats))

// ---------------------------------------------------------------------------------------------
// svelte templates: component use + functions used by the template
// ---------------------------------------------------------------------------------------------
function matchBrace(s, i) {
  // s[i] === '{'; returns index of the matching '}' or -1
  let depth = 0
  for (let k = i; k < s.length; k++) {
    const c = s[k]
    if (c === '"' || c === "'") { const q = c; k++; while (k < s.length && s[k] !== q) { if (s[k] === '\\') k++; k++ } }
    else if (c === '`') { k++; while (k < s.length && s[k] !== '`') { if (s[k] === '\\') k++; else if (s[k] === '$' && s[k + 1] === '{') { const e = matchBrace(s, k + 1); if (e < 0) return -1; k = e } k++ } }
    else if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return k }
  }
  return -1
}
function templateExprs(tpl) {
  const out = []
  for (let i = 0; i < tpl.length; i++) {
    if (tpl[i] !== '{') continue
    const e = matchBrace(tpl, i); if (e < 0) continue
    let t = tpl.slice(i + 1, e).trim()
    i = e
    if (!t) continue
    let m
    if (t[0] === '#') {
      if ((m = t.match(/^#each\s+([\s\S]+?)\s+as\s+/))) out.push(m[1])
      else if ((m = t.match(/^#await\s+([\s\S]+?)(?:\s+(?:then|catch)\b[\s\S]*)?$/))) out.push(m[1])
      else if ((m = t.match(/^#(?:if|key)\s+([\s\S]+)$/))) out.push(m[1])
    } else if (t[0] === ':') { if ((m = t.match(/^:else\s+if\s+([\s\S]+)$/))) out.push(m[1]) }
    else if (t[0] === '/') { /* closing tag */ }
    else if (t[0] === '@') { if ((m = t.match(/^@(?:html|render)\s+([\s\S]+)$/))) out.push(m[1]); else if ((m = t.match(/^@const\s+[\w$]+\s*=\s*([\s\S]+)$/))) out.push(m[1]) }
    else out.push(t.replace(/^\.\.\./, ''))
  }
  return out
}
function resolveSvelteSpec(spec, cf) {
  if (spec.startsWith('./') || spec.startsWith('../')) { const abs = path.posix.join(path.posix.dirname(cf), spec); return fexists(abs) ? abs : null }
  if (spec.startsWith('$lib/')) { for (const root of libRootsFor(cf)) { const abs = root + '/' + spec.slice(5); if (fexists(abs)) return abs } }
  return null
}
function findSvelteForExport(absFile, name, depth = 0, seen = new Set()) {
  if (depth > 5 || seen.has(absFile + '#' + name)) return null
  seen.add(absFile + '#' + name)
  const sf = program.getSourceFile(absFile); if (!sf) return null
  const importsDefault = new Map()
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause?.name && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text.endsWith('.svelte')) {
      const r = resolveSvelteSpec(st.moduleSpecifier.text, absFile)
      if (r) importsDefault.set(st.importClause.name.text, r)
    }
  }
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st)) continue
    const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null
    if (st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        if (el.name.text !== name) continue
        const orig = (el.propertyName ?? el.name).text
        if (!spec) { if (importsDefault.has(orig)) return importsDefault.get(orig); continue }
        if (spec.endsWith('.svelte')) { const rs = resolveSvelteSpec(spec, absFile); return orig === 'default' ? rs : null }
        const r = host.resolveModuleNames([spec], absFile)[0]; if (!r) continue
        const x = findSvelteForExport(r.resolvedFileName, orig, depth + 1, seen); if (x) return x
      }
    } else if (!st.exportClause && spec) {
      const r = host.resolveModuleNames([spec], absFile)[0]; if (!r) continue
      const x = findSvelteForExport(r.resolvedFileName, name, depth + 1, seen); if (x) return x
    }
  }
  return null
}

let templateRefs = 0, componentUses = 0
for (const fi of files.filter((f) => f.kind === 'svelte')) {
  const info = svelteInfo.get(fi.rel)
  const sf = sfOf.get(fi.rel)
  const scope = new Map() // local name -> [ids]
  const comps = new Map() // local name -> svelte rel
  for (const f of fnNodesByFile.get(fi.rel) ?? []) { if (!f.name.includes('.')) { const a = scope.get(f.name) ?? []; a.push(f.id); scope.set(f.name, a) } else { const root = f.name.split('.')[0]; /* object members are reachable as obj.member */ scope.set(root, scope.get(root) ?? []) } }
  if (sf) {
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !st.importClause || !ts.isStringLiteral(st.moduleSpecifier)) continue
      const spec = st.moduleSpecifier.text
      const bindings = []
      if (st.importClause.name) bindings.push({ local: st.importClause.name.text, imported: 'default', node: st.importClause.name })
      const nb = st.importClause.namedBindings
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) bindings.push({ local: el.name.text, imported: (el.propertyName ?? el.name).text, node: el.name })
      const resolved = host.resolveModuleNames([spec], realOf(sf.fileName) + '')[0]
      for (const b of bindings) {
        if (spec.endsWith('.svelte') && b.imported === 'default') { const rs = resolveSvelteSpec(spec, fi.abs); if (rs) comps.set(b.local, rs); continue }
        if (resolved && resolved.resolvedFileName.endsWith('.ts') && /^[A-Z]/.test(b.local)) { const sv = findSvelteForExport(resolved.resolvedFileName, b.imported); if (sv) { comps.set(b.local, sv); continue } }
        let s; try { s = checker.getSymbolAtLocation(b.node) } catch { s = undefined }
        if (s) { const r = targetsOfSymbol(s); if (r.status === 'resolved') { const a = scope.get(b.local) ?? []; a.push(...r.ids); scope.set(b.local, a) } }
      }
    }
  }
  const from = topOf(fi)
  const tpl = info.tplText
  const idents = new Set()
  for (const ex of templateExprs(tpl)) {
    const tsf = ts.createSourceFile('t.ts', '(' + ex + ')', ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
    const walk = (n) => {
      if (ts.isIdentifier(n)) {
        const p = n.parent
        if (!(p && ((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isParameter(p) && p.name === n)))) idents.add(n.text)
      }
      ts.forEachChild(n, walk)
    }
    walk(tsf)
  }
  for (const nm of idents) for (const id of scope.get(nm) ?? []) { addEdge(from, id, 'calls', 'template'); templateRefs++ }
  const re = /<([A-Z][\w$]*)(?:\.[\w$]+)?(?=[\s/>])/g
  let m; const seenComp = new Set()
  while ((m = re.exec(tpl))) {
    if (seenComp.has(m[1])) continue; seenComp.add(m[1])
    const target = comps.get(m[1]); if (!target) continue
    const tr = relOfFileName(target)
    const tfi = tr && fileByRel.get(tr); if (!tfi || tfi.kind !== 'svelte') continue
    addEdge(from, topOf(tfi), 'calls', 'component'); componentUses++
  }
}
log('template refs', templateRefs, 'component uses', componentUses)

// ---------------------------------------------------------------------------------------------
// routes and pages
// ---------------------------------------------------------------------------------------------
const routeNodes = [] // {id, method, path, segs, areaKey, group, file}
const routeSeen = new Set()
function addRoute({ method, path: p, fi, line, areaKey, doc = '' }) {
  const id = `route:${method} ${p}@${areaKey}`
  if (routeSeen.has(id)) return null
  routeSeen.add(id)
  addNode({ id, kind: 'route', name: `${method} ${p}`, parent: fi ? fi.fileId : null, file: fi?.rel ?? '', line: line ?? 0, exported: true, doc, layer: fi?.layer ?? 'L3' })
  const segs = p.split('/').filter(Boolean)
  routeNodes.push({ id, method, path: p, segs, areaKey, group: fi ? groupOf(fi.rel) : areaKey, file: fi?.rel ?? '' })
  return id
}
const areaKeyOf = (fi) => fi.areaId.replace(/^area:/, '').replace(/@L\d$/, '')

// SvelteKit file routes
function kitRoot(rel) {
  let m
  if ((m = rel.match(/^(modules\/[^/]+\/app)\/routes\/(.*)$/))) return { prefix: m[2] }
  if ((m = rel.match(/^(gremion-ui\/src|apps\/control-panel\/src|gremion-public\/src)\/routes\/(.*)$/))) return { prefix: m[2] }
  return null
}
function kitPath(rest) {
  const dir = path.posix.dirname(rest) === '.' ? '' : path.posix.dirname(rest)
  const segs = dir.split('/').filter(Boolean).filter((s) => !/^\(.*\)$/.test(s)).map((s) => s.replace(/^\[\[(.+)\]\]$/, ':$1?').replace(/^\[\.\.\.(.+)\]$/, ':*$1').replace(/^\[(.+)\]$/, ':$1'))
  return '/' + segs.join('/')
}
const pageNodeByRel = new Map()
for (const fi of files) {
  const kr = (fi.kind === 'ts' || fi.kind === 'svelte') ? kitRoot(fi.rel) : null
  if (!kr) continue
  const base = path.posix.basename(fi.rel)
  const p = kitPath(kr.prefix)
  if (base === '+server.ts') {
    const sf = sfOf.get(fi.rel); if (!sf) continue
    const names = new Set()
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name && (ts.getCombinedModifierFlags(st) & ts.ModifierFlags.Export) && VERBS.has(st.name.text)) names.add(st.name.text)
      else if (ts.isVariableStatement(st) && (ts.getCombinedModifierFlags(st.declarationList.declarations[0]) & ts.ModifierFlags.Export)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && VERBS.has(d.name.text)) names.add(d.name.text)
      else if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) for (const el of st.exportClause.elements) if (VERBS.has(el.name.text)) names.add(el.name.text)
    }
    for (const verb of [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      const fnId = (fnNodesByFile.get(fi.rel) ?? []).find((f) => f.name === verb)?.id
      const fnNode = fnId && nodes.get(fnId)
      const rid = addRoute({ method: verb, path: p, fi, line: fnNode?.line ?? 1, areaKey: areaKeyOf(fi), doc: fnNode?.doc ?? '' })
      if (rid && fnId) addEdge(rid, fnId, 'calls', 'route')
    }
  } else if (base === '+page.svelte') {
    const id = pageIdOf(fi)
    addNode({ id, kind: 'page', name: p === '/' ? '/ (home)' : p, parent: fi.fileId, file: fi.rel, line: 1, exported: true, doc: 'A page the browser can open at this path.', layer: fi.layer })
    pageNodeByRel.set(fi.rel, id)
  }
}
// L3 routes from route tables + case labels
for (const r of routeRecords) {
  const rid = addRoute({ method: r.method, path: r.path, fi: r.fi, line: r.line, areaKey: areaKeyOf(r.fi) })
  if (!rid) continue
  if (r.handlerId) addEdge(rid, r.handlerId, 'calls', 'route')
  else if (r.handlerExpr) { let s; try { s = checker.getSymbolAtLocation(r.handlerExpr) } catch { s = undefined } const t = targetsOfSymbol(s); for (const id of t.ids) addEdge(rid, id, 'calls', 'route') }
  if (r.op) {
    const cands = (allFnByName.get(r.op) ?? []).filter((id) => nodes.get(id).file === r.fi.rel || groupOf(nodes.get(id).file) === groupOf(r.fi.rel))
    const same = cands.filter((id) => nodes.get(id).file === r.fi.rel)
    for (const id of (same.length ? same : cands).slice(0, 1)) addEdge(rid, id, 'calls', 'route')
  }
}
for (const c of caseRoutes) { const rid = addRoute({ method: 'ANY', path: c.path, fi: c.fi, line: c.line, areaKey: areaKeyOf(c.fi) }); if (rid) addEdge(rid, c.owner, 'calls', 'route') }
// Fastify routes declared by the OpenAPI spec of kernel-api
try {
  const specPath = 'services/kernel-api/openapi/kernel-core.json'
  const spec = JSON.parse(fs.readFileSync(`${KERNEL}/${specPath}`, 'utf8'))
  const hsf = sfOf.get('services/kernel-api/src/handlers/index.ts')
  const handlerExprs = new Map()
  if (hsf) {
    const walk = (n) => { if (ts.isObjectLiteralExpression(n)) for (const pr of n.properties) { const nm = propName(pr.name); if (nm && (ts.isPropertyAssignment(pr) || ts.isShorthandPropertyAssignment(pr))) handlerExprs.set(nm, ts.isPropertyAssignment(pr) ? pr.initializer : pr.name) } ts.forEachChild(n, walk) }
    walk(hsf)
  }
  const targetsOfExpr = (e) => {
    e = unwrap(e)
    try {
      if (ts.isCallExpression(e)) return targetsOfSymbol(calleeSymbol(e.expression)).ids
      if (ts.isPropertyAccessExpression(e)) {
        const bs = checker.getSymbolAtLocation(unwrap(e.expression)); const d = bs?.valueDeclaration
        if (d && ts.isVariableDeclaration(d) && d.initializer && ts.isCallExpression(unwrap(d.initializer))) return targetsOfSymbol(calleeSymbol(unwrap(d.initializer).expression)).ids
        return targetsOfSymbol(checker.getSymbolAtLocation(e.name)).ids
      }
      if (ts.isIdentifier(e)) return targetsOfSymbol(checker.getSymbolAtLocation(e)).ids
    } catch { /* ignore */ }
    return []
  }
  const kfi = fileByRel.get('services/kernel-api/src/handlers/index.ts')
  for (const [pth, item] of Object.entries(spec.paths ?? {})) for (const [verb, op] of Object.entries(item)) {
    if (!VERBS.has(verb.toUpperCase()) || !op || typeof op !== 'object') continue
    const p = pth.replace(/\{([^}]+)\}/g, ':$1')
    const tids = op.operationId && handlerExprs.has(op.operationId) ? targetsOfExpr(handlerExprs.get(op.operationId)) : []
    const hn = tids.length ? nodes.get(tids[0]) : null
    const hfi = hn ? fileByRel.get(hn.file) : kfi
    const rid = addRoute({ method: verb.toUpperCase(), path: p, fi: hfi ?? kfi, line: hn?.line ?? 1, areaKey: 'services/kernel-api', doc: (op.summary ?? '').toString().slice(0, 200) })
    if (rid) for (const t of tids) addEdge(rid, t, 'calls', 'route')
  }
} catch (e) { log('WARN kernel-core.json routes not read:', e.message) }
log('routes', routeNodes.length, 'pages', pageNodeByRel.size)

// renders: page -> load/actions of its +page.server.ts/+page.ts and ancestor layouts
for (const [rel, pid] of pageNodeByRel) {
  const dir = path.posix.dirname(rel)
  const kr = kitRoot(rel)
  const rootDir = rel.slice(0, rel.length - kr.prefix.length - 0).replace(/\/$/, '') // .../routes
  const dirs = []
  let d = dir
  while (d.length >= rootDir.length) { dirs.push(d); if (d === rootDir) break; d = path.posix.dirname(d) }
  for (const dd of dirs) {
    for (const nm of (dd === dir ? ['+page.server.ts', '+page.ts', '+layout.server.ts', '+layout.ts'] : ['+layout.server.ts', '+layout.ts'])) {
      const f = `${dd}/${nm}`
      for (const fn of fnNodesByFile.get(f) ?? []) if (fn.name === 'load' || fn.name.startsWith('actions.') || fn.name === 'actions') addEdge(pid, fn.id, 'renders', 'page')
    }
    // module overlays can add layout/page server files for the same route in another app dir: ignore (limit documented)
  }
}

// ---------------------------------------------------------------------------------------------
// http matching
// ---------------------------------------------------------------------------------------------
const isParam = (s) => s.startsWith(':')
function segMatch(cs, rs, loose) {
  if (isParam(rs)) return true
  if (cs === rs) return true
  if (cs.includes(PH)) { if (cs === PH) return loose; const re = new RegExp('^' + cs.split(PH).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+') + '$'); return re.test(rs) }
  return false
}
function matchRoutes(cp, method, fi) {
  const cs = cp.split('/').filter(Boolean)
  const test = (loose) => routeNodes.filter((r) => {
    if (method && r.method !== 'ANY' && r.method !== method) return false
    const catchAll = r.segs.length && r.segs[r.segs.length - 1].startsWith(':*')
    if (!catchAll && r.segs.length !== cs.length) return false
    if (catchAll && cs.length < r.segs.length - 1) return false
    for (let i = 0; i < r.segs.length; i++) { if (catchAll && i === r.segs.length - 1) return true; if (!segMatch(cs[i], r.segs[i], loose)) return false }
    return true
  })
  let m = test(false)
  if (!m.length) m = test(true)
  if (m.length <= 1) return m
  // disambiguate by owner affinity
  const g = groupOf(fi.rel)
  const sameGroup = m.filter((r) => r.group === g); if (sameGroup.length) return sameGroup
  const low = lc(fi.rel)
  const byName = m.filter((r) => { const last = lc(r.areaKey.split('/').pop()); return last && low.includes(last) }); if (byName.length) return byName
  return m.length <= 3 ? m : []
}
let httpAmbiguous = 0
for (const h of httpHits) {
  const ms = matchRoutes(h.path, h.method, h.fi)
  if (!ms.length) continue
  for (const r of ms) addEdge(h.owner, r.id, 'http', 'path')
}
log('http hits', httpHits.length, 'ambiguous skipped', httpAmbiguous)

// ---------------------------------------------------------------------------------------------
// sql matching
// ---------------------------------------------------------------------------------------------
for (const h of sqlHits) {
  const g = groupOf(h.fi.rel)
  for (const name of h.names) {
    const cands = tablesByName.get(name) ?? []
    let pick = cands.filter((c) => c.group === g)
    if (!pick.length) pick = cands.length <= 2 ? cands : []
    const seen = new Set()
    for (const c of pick) { const k = c.schema + '.' + name; if (seen.has(k)) continue; seen.add(k); addEdge(h.owner, c.id, 'sql', 'text') }
  }
}

// ---------------------------------------------------------------------------------------------
// event matching
// ---------------------------------------------------------------------------------------------
function natsMatch(pat, subj) {
  const p = pat.split('.'), s = subj.split('.')
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '>') return s.length > i
    if (i >= s.length) return false
    if (p[i] === '*' || s[i] === '*' || s[i].includes('*')) continue
    if (p[i] !== s[i]) return false
  }
  return p.length === s.length
}
let eventMatches = 0
for (const pub of pubHits) for (const sub of subHits) if (natsMatch(sub.pat, pub.subj)) { addEdge(pub.owner, sub.owner, 'event', 'subject'); eventMatches++ }
log('events publish sites', pubHits.length, 'subscribe sites', subHits.length, 'matches', eventMatches)

// ---------------------------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------------------------
const nodeList = [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
const edgeList = [...edgesMap.values()].sort((a, b) => (a.from + a.to + a.kind < b.from + b.to + b.kind ? -1 : 1))
const layerOf = (id) => nodes.get(id)?.layer ?? ''
const kinds = {}; for (const n of nodeList) kinds[n.kind] = (kinds[n.kind] ?? 0) + 1
const ekinds = {}; for (const e of edgeList) ekinds[e.kind] = (ekinds[e.kind] ?? 0) + 1
const perLayer = {}
for (const [id] of LAYERS) perLayer[id] = { nodes: nodeList.filter((n) => n.layer === id && n.kind !== 'layer').length, edgesTouching: edgeList.filter((e) => layerOf(e.from) === id || layerOf(e.to) === id).length }
const callSites = stats.resolved + stats.localClosure + stats.port + stats.unresolved
const unresolvedCalls = stats.port + stats.unresolved
const ratioPct = callSites ? Math.round(((stats.resolved + stats.localClosure) / callSites) * 1000) / 10 : 0
const meta = {
  commit: COMMIT,
  generatedAt: USE_NOW ? new Date().toISOString() : COMMIT_DATE,
  generatedAtMeaning: USE_NOW ? 'time of this run' : 'commit date of the analysed commit (the script is deterministic; pass --now for wall-clock time)',
  workingTreeDirty: DIRTY,
  typescript: ts.version,
  counts: { nodes: nodeList.length, edges: edgeList.length, nodesByKind: kinds, edgesByKind: ekinds, perLayer, callSitesSeen: siteCount },
  resolvedCalls: stats.resolved,
  unresolvedCalls,
  callBreakdown: { ...stats, unresolvedReasons: Object.fromEntries([...unresolvedReasons].sort((a, b) => b[1] - a[1])), topPortMembers: Object.fromEntries([...portNames].sort((a, b) => b[1] - a[1]).slice(0, 40)) },
  resolvedRatioPercent: ratioPct,
  resolvedRatioNote: 'resolved = (call sites with an edge + calls to local closures) / (those + unresolved + interface calls with no implementer). Calls into node_modules, Node and the DOM, generated clients, and classes with no explicit constructor are counted separately and left out of the ratio.',
  events: { publishCallsSeen: eventSites.publishCalls, subscribeCallsSeen: eventSites.subscribeCalls, publishSitesWithKnownSubject: pubHits.length, subscribeSitesWithKnownSubject: subHits.length, matched: eventMatches },
  http: { pathLiteralsInCallArguments: httpHits.length },
  unresolvedImportSpecifiers: Object.fromEntries([...unresolvedImports].sort((a, b) => b[1] - a[1]).slice(0, 15)),
  edgeFields: 'kind is one of calls, http, sql, renders, event. `via` tells how the edge was found (call, ref, template, component, route, path, text, subject, page). `n` is how many call sites produced it.',
}
// A graph with only the six layer nodes is structurally empty: the one failure that is not a crash.
if (nodeList.filter((n) => n.kind !== 'layer').length === 0) { console.error('the graph has no nodes: no source file was found under the kernel folder'); process.exit(3) }
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify({ meta, nodes: nodeList, edges: edgeList }, null, 1) + '\n')
log('wrote', OUT)

// ---------------------------------------------------------------------------------------------
// self checks
// ---------------------------------------------------------------------------------------------
const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }) }
for (const L of ['L1', 'L2', 'L3', 'L4', 'L5']) {
  check(`${L} has nodes`, perLayer[L].nodes > 0, `${perLayer[L].nodes}`)
  check(`${L} has edges`, perLayer[L].edgesTouching > 0, `${perLayer[L].edgesTouching}`)
}
const ctxFn = nodeList.find((n) => n.kind === 'function' && n.name === 'contextForProvisioningTenant' && n.file === 'gremion-ui/src/lib/server/tenant/registry.ts')
check('contextForProvisioningTenant exists', !!ctxFn, ctxFn ? `${ctxFn.file}:${ctxFn.line}` : 'missing')
const callers = ctxFn ? edgeList.filter((e) => e.to === ctxFn.id && e.kind === 'calls') : []
check('contextForProvisioningTenant has a caller edge', callers.length > 0, callers.map((e) => nodes.get(e.from)?.name + ' (' + nodes.get(e.from)?.file + ')').join('; '))
check('at least one http edge', (ekinds.http ?? 0) > 0, `${ekinds.http ?? 0}`)
check('at least one sql edge', (ekinds.sql ?? 0) > 0, `${ekinds.sql ?? 0}`)
const dangling = edgeList.filter((e) => !nodes.has(e.from) || !nodes.has(e.to))
check('every edge endpoint exists', dangling.length === 0, `${dangling.length} dangling`)
const orphanParents = nodeList.filter((n) => n.kind !== 'layer' && !nodes.has(n.parent))
check('every node parent exists', orphanParents.length === 0, `${orphanParents.length} orphans`)
check('exactly six layers', nodeList.filter((n) => n.kind === 'layer').length === 6)

console.log('\n=== counts ===')
console.log('nodes', nodeList.length, JSON.stringify(kinds))
console.log('edges', edgeList.length, JSON.stringify(ekinds))
console.log('per layer', JSON.stringify(perLayer))
console.log('\n=== call resolution ===')
console.log('call sites seen', siteCount, JSON.stringify(stats))
console.log(`resolved ${stats.resolved} (+${stats.localClosure} local closures) vs unresolved ${unresolvedCalls}; ratio ${ratioPct}%`)
console.log('unresolved reasons', JSON.stringify(Object.fromEntries([...unresolvedReasons].sort((a, b) => b[1] - a[1]).slice(0, 8))))
console.log('\n=== self checks ===')
let failed = 0
for (const c of checks) { console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  ${c.detail}`); if (!c.ok) failed++ }
// The checks are information only. A moved or renamed function must not fail a run that wrote a good graph.
console.log(failed ? `\n${failed} check(s) did not pass (printed, not fatal)` : '\nall checks passed')
log('done')
process.exit(0)
