#!/usr/bin/env node
// Storage-seam bypass scan (TASK-117, PRD-PLAT-012 / TRD-065).
//
// Every tenant file, draft and media object is resolved through ONE seam:
// @gremion/storage's getStorageFor(tenantId). This guard fails when code
// assembles a storage path or writes to disk outside it.
//
//   s1  no export named `getStorage` (the old zero-argument, tenant-blind
//       accessor) anywhere, and no exported `storage` proxy under a storage/
//       directory. `getStorageFor` is the only accessor.
//   s2  no ambient tenant read — currentTenantId() / requireTenant() /
//       getTenant() / getTenantOrNull() — in any file under a storage/
//       directory (incl. packages/storage). The tenant is an explicit argument.
//   s3  no storage path assembled and no filesystem WRITE in gremion-ui/src,
//       gremion-public/src, modules/ or packages/ outside packages/storage,
//       except the named ALLOWLIST below:
//       - RECEIPT_STORAGE_DIR (the storage root) is read only by the seam and
//         gremion-ui's config adapter;
//       - a file that imports an fs module (static/multi-line import, `import
//         x = require`, require, dynamic import, process.getBuiltinModule,
//         any call with an fs module literal such as createRequire(…)('fs'),
//         with ' " or ` quotes) may not import a write-capable function,
//         reference one on the module or its promises namespace
//         (`fs.writeFile`, called or not), destructure one from it, alias,
//         export or pass on the whole module, use computed access on it
//         (`fs['x']`), call one as a member, or re-export fs.
//
// Scope: *.ts/*.js/*.mjs/*.cjs/*.mts/*.cts/*.svelte, minus node_modules,
// .svelte-kit, __tests__/, packages/<pkg>/{dist,build,test,tests} and test
// files (*.test.* / *.spec.*) — tests write fixtures on purpose. civitas only
// (Q3): the StuRaOS copies are a recorded gap, not scanned here.
// NOT covered (recorded residuals): module names computed at runtime,
// shelling out (child_process `cp`/`tee`), non-Node runtimes' write APIs, and
// raw fs READS of tenant paths — a regex scan is a tripwire, not a proof.
//
// Refuses to pass vacuously: zero files scanned, a missing scan root, a stale
// allowlist entry (one that no longer matches a write), an entry without a
// reason, a residual and a pinned write-site count, a directory-wide entry, or
// an allowlisted file whose write-site count changed are all failures.
//
// Run:  node scripts/check-storage-seam.mjs [--root <dir>]
// Test: node --test scripts/check-storage-seam.test.mjs

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const SCAN_ROOTS = ['gremion-ui/src', 'gremion-public/src', 'modules', 'packages']
export const SEAM_DIR = 'packages/storage'
/** gremion-ui's config adapter: the one place outside the seam that reads the storage root. */
export const ADAPTER_DIR = 'gremion-ui/src/lib/server/storage/'

/**
 * s3 allowlist. `path` is one repo-relative file; `sites` pins how many write
 * sites it may hold, so a new write in an allowlisted file fails until
 * someone reviews it and moves the pin. Every entry names WHY the write is not tenant object storage and
 * WHAT remains to be done (the residual). Q7: the council-owned Nextcloud
 * files module is out of scope per PRD-PLAT-004 and would be listed here — it
 * is not present in this repository (network I/O over WebDAV, not fs writes),
 * so no entry exists for it; a stale entry would fail this guard.
 */
export const ALLOWLIST = [
  {
    path: 'gremion-ui/src/lib/server/config.ts',
    sites: 3,
    reason:
      "per-tenant INSTALL CONFIG (config.json) written atomically under the tenant's own registry-resolved configPath — deployment configuration, not a tenant file/draft/media object",
    residual:
      'config.json lives on the /data volume beside, not inside, the storage seam; revisit if tenant config moves to the database (TRD-223 object-store cutover)',
  },
  {
    path: 'gremion-ui/src/lib/server/setup-token.ts',
    sites: 4,
    reason:
      "one-shot setup-wizard secret (.setup-token, mode 0600) in the tenant's configPath directory — an operator credential file, not tenant content",
    residual: 'the token file is not routed through the seam; retire it when setup moves to a registry-issued token',
  },
  {
    path: 'gremion-ui/src/routes/api/settings/backup/+server.ts',
    sites: 3,
    reason:
      'writes the backup-check TRIGGER file the backup sidecar polls for — an IPC flag for ops tooling, not tenant content',
    residual: 'replace the trigger file with a broker message when the backup arm gets a service port',
  },
  {
    path: 'packages/generated-clients/src/oasdiff-gate.ts',
    sites: 5,
    reason:
      'CI gate: writes two spec files into a private mkdtemp dir and removes it — build tooling, never at runtime, never tenant data',
    residual: 'none at runtime; keep the module out of any runtime import path',
  },
  {
    path: 'packages/generated-clients/tools/generate.mjs',
    sites: 3,
    reason: 'code generator: writes generated client source into the repository at build time — never tenant data',
    residual: 'none at runtime; build tooling only',
  },
  {
    path: 'packages/fastify-service-template/src/scaffold.ts',
    sites: 3,
    reason:
      "scaffold CLI (TASK-076): emits a brand-new service's boilerplate (package.json, tsconfig.json, src/*.ts) into a caller-chosen out directory at dev time — code generation, never tenant object storage",
    residual: 'none at runtime; the scaffold is a one-shot dev-time CLI, never on an app request path',
  },
  {
    path: 'packages/generated-clients-dart/src/fixture.ts',
    sites: 6,
    reason:
      "test-only fixture helper, never imported by the check or the writer: builds a throwaway OpenAPI/AsyncAPI spec tree under a mkdtemp scratch dir so the drift/codegen pipeline can be exercised without Docker, Java or a Dart SDK — never tenant data",
    residual:
      "none at runtime; consider naming it *.fixture.test.ts so the guard's own test-file skip covers it directly instead of an allowlist entry",
  },
  {
    path: 'packages/generated-clients-dart/src/pipeline.ts',
    sites: 11,
    reason:
      'the one GenerateFn shared by the writer and the drift check: stages openapi-generator/dart output under a mkdtemp scratch dir, runs dart pub get / build_runner / analyze there, and copies the resulting pubspec.lock — build-time client generation, never tenant data',
    residual: 'none at runtime; build/CI tooling only, never on an app request path',
  },
  {
    path: 'packages/generated-clients-dart/src/tools.ts',
    sites: 2,
    reason:
      'resolves the pinned openapi-generator/Dart SDK binaries (PATH, else a digest-pinned Docker image) and creates the Docker pub-cache directory so it is not left root-owned — build tooling, never tenant data',
    residual: 'none at runtime; build/CI tooling only',
  },
  {
    path: 'packages/generated-clients-dart/src/writer.ts',
    sites: 6,
    reason:
      'the write side of the Dart client generator (tools/generate.mjs is its CLI): syncs each generated package in the repo to exactly what the pipeline emits and deletes files it no longer emits — build-time codegen output, never tenant data',
    residual: 'none at runtime; build/CI tooling only',
  },
  {
    path: 'packages/edge-routers/src/emit.ts',
    sites: 11,
    reason:
      "TASK-034 (TRD-189/TRD-074): the single per-tenant router emitter writes Traefik file-provider routers into the host's etc/edge directory (atomic tmp + rename + fsync, idempotent) — platform edge configuration Traefik reads, not a tenant file/draft/media object; the seam's backends are not a directory Traefik can watch",
    residual:
      "the caller (TASK-043's provisioner) must run where etc/edge is writable, and hygiene j4 lets no compose service but traefik mount etc/edge, read-only, so the app process cannot be that place; revisit if the edge moves to a Traefik HTTP/KV provider",
  },
  {
    path: 'packages/edge-routers/src/sync.ts',
    sites: 1,
    reason:
      "TASK-034: the fleet sync removes an orphaned router file of the emitter's own name shape from the host's etc/edge directory — platform edge configuration, not tenant content",
    residual: 'same as packages/edge-routers/src/emit.ts: its caller must run where etc/edge is writable, which hygiene j4 keeps out of the app process',
  },
]

const CODE_EXT = /\.(ts|js|mjs|cjs|mts|cts|svelte)$/
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]s$/
/** Skipped anywhere. */
const SKIP_DIRS = new Set(['node_modules', '.svelte-kit', '__tests__'])
/** Skipped only directly under a package root (packages/<pkg>/dist, …/test):
 *  inside an app's src/ a directory named `build` or `tests` is source (a
 *  route, a helper) and is scanned. */
const PACKAGE_ONLY_SKIP_DIRS = new Set(['dist', 'build', 'test', 'tests'])

const FS_MODULE = String.raw`(?:node:)?(?:fs|fs\/promises)|fs-extra|graceful-fs`
const Q = String.raw`['"\x60]`
const FS_IMPORT_RES = [
  new RegExp(String.raw`\bfrom\s*${Q}(?:${FS_MODULE})${Q}`),
  new RegExp(String.raw`\bimport\s*${Q}(?:${FS_MODULE})${Q}`),
  // require('fs'), import('fs'), and ANY call with an fs module literal —
  // createRequire(import.meta.url)('fs'), req('fs') …
  new RegExp(String.raw`[\w$)]\s*\(\s*${Q}(?:${FS_MODULE})${Q}\s*\)`),
  new RegExp(String.raw`\bgetBuiltinModule\s*\(\s*${Q}(?:${FS_MODULE})${Q}\s*\)`),
]
/** Re-exporting an fs module (or its members) launders it past the import check. */
const FS_REEXPORT = new RegExp(String.raw`\bexport\s*(?:\*|\{[^}]*\})[\s\S]*?\bfrom\s*${Q}(?:${FS_MODULE})${Q}`)
const WRITE_BASE = [
  'writeFile', 'appendFile', 'createWriteStream', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink',
  'rename', 'copyFile', 'cp', 'truncate', 'ftruncate', 'symlink', 'link', 'chmod', 'chown',
  'lchown', 'utimes', 'open', 'write', 'writev',
  // fs-extra
  'outputFile', 'outputJson', 'writeJson', 'ensureFile', 'ensureDir', 'mkdirp', 'mkdirs',
  'move', 'copy', 'remove', 'emptyDir',
]
const WRITE_NAME = String.raw`(?:${WRITE_BASE.join('|')})(?:Sync)?`
/** `.writeFile(`, `fs.promises.rm (` … */
const MEMBER_WRITE = new RegExp(String.raw`\.\s*(${WRITE_NAME})\s*\(`)

function isTest(rel) {
  return TEST_FILE.test(rel)
}

function walk(absDir, out, root) {
  for (const name of readdirSync(absDir)) {
    const abs = join(absDir, name)
    const st = statSync(abs)
    if (st.isDirectory()) {
      const parentRel = relative(root, absDir).split(sep).join('/')
      const packageLevel = /^packages\/[^/]+$/.test(parentRel)
      if (!SKIP_DIRS.has(name) && !(packageLevel && PACKAGE_ONLY_SKIP_DIRS.has(name))) walk(abs, out, root)
    } else if (CODE_EXT.test(name)) {
      out.push(abs)
    }
  }
  return out
}

function inStorageDir(rel) {
  return rel.split('/').includes('storage') || rel.startsWith(`${SEAM_DIR}/`)
}

const escapeRe = (n) => n.replace(/[$]/g, '\\$')

/** Write-capable names a file pulls out of an fs module via braces, with
 *  their local aliases — across lines: `import {\n  writeFile as w,\n} from
 *  'fs'` -> ['writeFile', 'w']. Also `const { rm } = require('fs')`. */
function importedWriteNames(text) {
  const names = new Set()
  const writeRe = new RegExp(String.raw`^${WRITE_NAME}$`)
  const braceFromFs = new RegExp(
    String.raw`\{([^{}]*)\}\s*(?:from\s*${Q}(?:${FS_MODULE})${Q}|=\s*(?:await\s+)?(?:require|import|process\.getBuiltinModule)\s*\(\s*${Q}(?:${FS_MODULE})${Q})`,
    'g',
  )
  for (const m of text.matchAll(braceFromFs)) {
    for (const part of m[1].split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+|\s*:\s*/)
      if (orig && writeRe.test(orig.trim())) {
        names.add(orig.trim())
        if (alias) names.add(alias.trim())
      }
    }
  }
  return names
}

/** Local names bound to a whole fs module (or its `promises` namespace):
 *  `import fs from`, `import * as fs from`, `import fs, {…} from`,
 *  `import fs = require(…)`, `const fs = require/import/getBuiltinModule(…)`,
 *  `{ promises as fsp }` / `{ promises: fsp }`. */
function fsBindings(text) {
  const out = new Set()
  const add = (n) => n && out.add(n)
  for (const m of text.matchAll(new RegExp(String.raw`\bimport\s+(?:\*\s+as\s+)?([\w$]+)\s*(?:,\s*\{[^}]*\}\s*)?from\s*${Q}(?:${FS_MODULE})${Q}`, 'g'))) add(m[1])
  for (const m of text.matchAll(new RegExp(String.raw`\bimport\s+([\w$]+)\s*=\s*require\s*\(\s*${Q}(?:${FS_MODULE})${Q}`, 'g'))) add(m[1])
  for (const m of text.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?(?:require|import|process\.getBuiltinModule)\s*\(\s*${Q}(?:${FS_MODULE})${Q}`, 'g'))) add(m[1])
  for (const m of text.matchAll(/\bpromises\s*(?:as|:)\s*([\w$]+)/g)) add(m[1])
  // `import { promises } from 'fs'` binds the bare name
  for (const m of text.matchAll(new RegExp(String.raw`\{([^{}]*)\}\s*from\s*${Q}(?:${FS_MODULE})${Q}`, 'g'))) {
    if (/(?:^|,)\s*promises\s*(?:,|$)/.test(m[1])) add('promises')
  }
  // derived namespaces: const fsp = fs.promises (to a fixed point)
  for (let grew = true; grew; ) {
    grew = false
    // Snapshot before iterating: the inner loop adds to `out`, and this pass
    // must run against the set as it stood when the pass started; the outer
    // `while (grew)` re-runs once more to pick up anything just added.
    for (const b of Array.from(out)) {
      const re = new RegExp(String.raw`\b(?:const|let|var)\s+([\w$]+)\s*=\s*${escapeRe(b)}\s*\.\s*promises\b`, 'g')
      for (const m of text.matchAll(re)) {
        if (!out.has(m[1])) {
          out.add(m[1])
          grew = true
        }
      }
    }
  }
  return out
}

/** A line is blanked only when it is ENTIRELY comment: it starts with `//`,
 *  or starts with `/*` or `*` and contains no `*\/` followed by more code.
 *  `/* ok *\/ fs.writeFileSync(…)` is therefore still scanned. */
function isCommentOnly(line) {
  const t = line.trim()
  if (t.startsWith('//')) return true
  if (!t.startsWith('/*') && !t.startsWith('*')) return false
  const close = t.indexOf('*/')
  return close === -1 || t.slice(close + 2).trim() === ''
}

function scanFile(rel, text) {
  const findings = []
  const lines = text.split('\n').map((l) => (isCommentOnly(l) ? '' : l))
  const add = (guard, i, why) => findings.push({ guard, file: rel, line: i + 1, text: lines[i].trim(), why })

  // s1
  lines.forEach((line, i) => {
    if (/\bexport\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*getStorage\b(?!\w)/.test(line) ||
        /\bexport\s+(?:const|let|var)\s+getStorage\b(?!\w)/.test(line) ||
        /\bexport\s*\{[^}]*\b(?:as\s+)?getStorage\b(?!\w)[^}]*\}/.test(line)) {
      add('s1', i, 'export named getStorage (zero-arg, tenant-blind accessor)')
    } else if (inStorageDir(rel) && /\bexport\s+(?:const|let|var)\s+storage\b(?!\w)/.test(line)) {
      add('s1', i, 'exported tenant-blind `storage` proxy')
    }
  })

  // s2
  if (inStorageDir(rel)) {
    lines.forEach((line, i) => {
      if (/\b(?:currentTenantId|requireTenant|getTenant|getTenantOrNull)\s*\(/.test(line)) {
        add('s2', i, 'ambient tenant read inside the storage seam')
      }
    })
  }

  // s3 — the storage root read outside the seam and its config adapter
  if (!rel.startsWith(`${SEAM_DIR}/`) && !rel.startsWith(ADAPTER_DIR)) {
    lines.forEach((line, i) => {
      if (/\bRECEIPT_STORAGE_DIR\b/.test(line)) add('s3', i, 'storage root (RECEIPT_STORAGE_DIR) read outside the seam')
    })
  }
  // s3 — fs writes
  const code = lines.join('\n')
  if (!rel.startsWith(`${SEAM_DIR}/`) && FS_IMPORT_RES.some((re) => re.test(code))) {
    const imported = importedWriteNames(code)
    const bindings = fsBindings(code)
    const bare = imported.size
      ? new RegExp(String.raw`(?<![\w$.])(${[...imported].map(escapeRe).join('|')})\b`)
      : null
    const b = bindings.size ? [...bindings].map(escapeRe).join('|') : null
    const bindingUse = b
      ? [
          // fs.writeFile / fs.promises.rm — a reference, called or not
          new RegExp(String.raw`(?<![\w$.])(?:${b})(?:\s*\.\s*promises)?\s*\.\s*(${WRITE_NAME})\b`),
          // fs['writeFile'] / fs[name] — computed access is refused outright
          new RegExp(String.raw`(?<![\w$.])(?:${b})(?:\s*\.\s*promises)?\s*(\[)`),
          // const { writeFileSync } = fs
          new RegExp(String.raw`\{[^}]*\b(${WRITE_NAME})\b[^}]*\}\s*=\s*(?:await\s+)?(?:${b})\b`),
          // const f = fs — a whole-module alias escapes binding tracking
          new RegExp(String.raw`=\s*(?:await\s+)?(${b})\s*(?:;|,|$)`),
          // export default fs / export { fs } — laundering the module to other files
          new RegExp(String.raw`\bexport\s+default\s+(${b})\b`),
          new RegExp(String.raw`\bexport\s*\{[^}]*\b(${b})\b[^}]*\}`),
          // helper(fs) — handing the module to other code
          new RegExp(String.raw`[(,]\s*(${b})\s*[,)]`),
        ]
      : []
    lines.forEach((line, i) => {
      if (FS_REEXPORT.test(line)) return add('s3', i, 're-exports an fs module')
      const isImportLine = FS_IMPORT_RES.some((re) => re.test(line)) && [...imported].some((n) => new RegExp(String.raw`\b${escapeRe(n)}\b`).test(line))
      if (isImportLine) return add('s3', i, 'imports a write-capable fs function')
      for (const re of bindingUse) {
        const m = re.exec(line)
        if (m) {
          const what = m[1] === '[' ? 'computed access on an fs module' : bindings.has(m[1]) ? `fs module escapes via ${m[1]}` : `fs write reference: ${m[1]}`
          return add('s3', i, what)
        }
      }
      const m = MEMBER_WRITE.exec(line) ?? (bare ? bare.exec(line) : null)
      if (m) add('s3', i, `fs write call: ${m[1]}`)
    })
  }
  return findings
}

function matchesEntry(entry, rel) {
  return rel === entry.path
}

/** Scan `root`. Returns { filesScanned, findings, allowlisted, problems }. */
export function scan({ root = ROOT, allowlist = ALLOWLIST } = {}) {
  const problems = []
  const findings = []
  const allowlisted = []
  let filesScanned = 0

  for (const e of allowlist) {
    if (!e.reason || !e.residual) problems.push(`allowlist entry ${e.path} has no reason or no residual`)
    if (!Number.isInteger(e.sites) || e.sites < 1) problems.push(`allowlist entry ${e.path} pins no write-site count`)
    if (e.path.endsWith('/')) problems.push(`allowlist entry ${e.path} is directory-wide; name the file`)
  }
  for (const r of SCAN_ROOTS) {
    const abs = join(root, r)
    if (!existsSync(abs)) {
      problems.push(`scan root ${r} does not exist under ${root}`)
      continue
    }
    for (const file of walk(abs, [], root)) {
      const rel = relative(root, file).split(sep).join('/')
      if (isTest(rel)) continue
      filesScanned++
      for (const f of scanFile(rel, readFileSync(file, 'utf8'))) {
        const entry = f.guard === 's3' ? allowlist.find((e) => matchesEntry(e, rel)) : undefined
        if (entry) allowlisted.push({ ...f, entry: entry.path })
        else findings.push(f)
      }
    }
  }
  if (filesScanned === 0) problems.push('scanned zero files — refusing to pass vacuously')
  for (const e of allowlist) {
    const n = allowlisted.filter((a) => a.entry === e.path).length
    if (e.reason && e.residual && n === 0) {
      problems.push(`allowlist entry ${e.path} is stale: it matches no fs write — remove it`)
    } else if (Number.isInteger(e.sites) && n !== e.sites) {
      problems.push(`allowlist entry ${e.path} pins ${e.sites} write site(s) but the file has ${n} — review the change, then update the pin`)
    }
  }
  return { filesScanned, findings, allowlisted, problems }
}

function main(argv) {
  const i = argv.indexOf('--root')
  const root = i >= 0 ? argv[i + 1] : ROOT
  const r = scan({ root })
  if (r.findings.length || r.problems.length) {
    for (const f of r.findings) console.error(`${f.guard} ${f.file}:${f.line} ${f.why}: ${f.text}`)
    for (const p of r.problems) console.error(`problem: ${p}`)
    console.error(
      `check-storage-seam: FAIL — ${r.findings.length} finding(s), ${r.problems.length} problem(s) over ${r.filesScanned} files. ` +
        'Route tenant files through getStorageFor(tenantId) from @gremion/storage, or add a reasoned allowlist entry.',
    )
    return 1
  }
  const files = new Set(r.allowlisted.map((a) => a.file)).size
  console.log(
    `check-storage-seam: OK — ${r.filesScanned} files scanned under ${SCAN_ROOTS.join(', ')}; ` +
      `s1/s2/s3 clean; ${r.allowlisted.length} allowlisted write site(s) in ${files} file(s)`,
  )
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2))
}
