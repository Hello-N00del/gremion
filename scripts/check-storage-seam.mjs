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
//   s3  no filesystem WRITE in gremion-ui/src, gremion-public/src, modules/ or
//       packages/ outside packages/storage, except the named ALLOWLIST below.
//       A file is examined when it imports an fs module (static import,
//       require, dynamic import, process.getBuiltinModule); in such a file
//       any write-capable fs function it imports, and any call of one (bare,
//       aliased or as a member, e.g. `fs.promises.writeFile(`), is a finding.
//
// Scope: *.ts/*.js/*.mjs/*.cjs/*.mts/*.cts/*.svelte, minus node_modules,
// build output and test files (*.test.* / *.spec.*, and __tests__/, test/,
// tests/ directories) — tests write fixtures on purpose. civitas only (Q3):
// the StuRaOS copies are a recorded gap, not scanned here.
//
// Refuses to pass vacuously: zero files scanned, a missing scan root, a stale
// allowlist entry (one that no longer matches a write) or an entry without a
// reason and a residual are all failures.
//
// Run:  node scripts/check-storage-seam.mjs [--root <dir>]
// Test: node --test scripts/check-storage-seam.test.mjs

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const SCAN_ROOTS = ['gremion-ui/src', 'gremion-public/src', 'modules', 'packages']
export const SEAM_DIR = 'packages/storage'

/**
 * s3 allowlist. `path` is a repo-relative file, or a directory prefix ending
 * in `/`. Every entry names WHY the write is not tenant object storage and
 * WHAT remains to be done (the residual). Q7: the council-owned Nextcloud
 * files module is out of scope per PRD-PLAT-004 and would be listed here — it
 * is not present in this repository (network I/O over WebDAV, not fs writes),
 * so no entry exists for it; a stale entry would fail this guard.
 */
export const ALLOWLIST = [
  {
    path: 'gremion-ui/src/lib/server/config.ts',
    reason:
      "per-tenant INSTALL CONFIG (config.json) written atomically under the tenant's own registry-resolved configPath — deployment configuration, not a tenant file/draft/media object",
    residual:
      'config.json lives on the /data volume beside, not inside, the storage seam; revisit if tenant config moves to the database (TRD-223 object-store cutover)',
  },
  {
    path: 'gremion-ui/src/lib/server/setup-token.ts',
    reason:
      "one-shot setup-wizard secret (.setup-token, mode 0600) in the tenant's configPath directory — an operator credential file, not tenant content",
    residual: 'the token file is not routed through the seam; retire it when setup moves to a registry-issued token',
  },
  {
    path: 'gremion-ui/src/routes/api/settings/backup/+server.ts',
    reason:
      'writes the backup-check TRIGGER file the backup sidecar polls for — an IPC flag for ops tooling, not tenant content',
    residual: 'replace the trigger file with a broker message when the backup arm gets a service port',
  },
  {
    path: 'packages/generated-clients/',
    reason:
      'build/CI tooling: the client generator writes generated source, and the oasdiff gate writes two spec files to a private mkdtemp dir — never at runtime, never tenant data',
    residual: 'none at runtime; keep the package out of any runtime import path',
  },
]

const CODE_EXT = /\.(ts|js|mjs|cjs|mts|cts|svelte)$/
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]s$/
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.svelte-kit', '__tests__', 'test', 'tests'])

const FS_MODULE = String.raw`(?:node:)?(?:fs|fs\/promises)|fs-extra|graceful-fs`
const FS_IMPORT_RES = [
  new RegExp(String.raw`\bfrom\s*['"](?:${FS_MODULE})['"]`),
  new RegExp(String.raw`\bimport\s*['"](?:${FS_MODULE})['"]`),
  new RegExp(String.raw`\b(?:require|import)\s*\(\s*['"](?:${FS_MODULE})['"]\s*\)`),
  new RegExp(String.raw`\bgetBuiltinModule\s*\(\s*['"](?:${FS_MODULE})['"]\s*\)`),
]
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
/** `{ writeFileSync, rm as nuke }` — names inside an import/require/destructure brace. */
const BRACE_SPEC = /\{([^{}]*)\}/g

function isTest(rel) {
  return TEST_FILE.test(rel)
}

function walk(absDir, out) {
  for (const name of readdirSync(absDir)) {
    const abs = join(absDir, name)
    const st = statSync(abs)
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(abs, out)
    } else if (CODE_EXT.test(name)) {
      out.push(abs)
    }
  }
  return out
}

function inStorageDir(rel) {
  return rel.split('/').includes('storage') || rel.startsWith(`${SEAM_DIR}/`)
}

/** Write-capable names a file pulls out of an fs module via braces, with
 *  their local aliases: `{ writeFile as w }` -> ['writeFile', 'w']. */
function importedWriteNames(text) {
  const names = new Set()
  const writeRe = new RegExp(String.raw`^${WRITE_NAME}$`)
  for (const m of text.matchAll(BRACE_SPEC)) {
    // only braces on a line that also names an fs module
    const lineStart = text.lastIndexOf('\n', m.index) + 1
    const lineEnd = text.indexOf('\n', m.index + m[0].length)
    const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
    if (!FS_IMPORT_RES.some((re) => re.test(line))) continue
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

function scanFile(rel, text) {
  const findings = []
  const lines = text.split('\n')
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

  // s3
  if (!rel.startsWith(`${SEAM_DIR}/`) && FS_IMPORT_RES.some((re) => re.test(text))) {
    const imported = importedWriteNames(text)
    const bare = imported.size
      ? new RegExp(String.raw`(?<![\w$.])(${[...imported].map((n) => n.replace(/\$/g, '\\$')).join('|')})\s*\(`)
      : null
    lines.forEach((line, i) => {
      const isImportLine = FS_IMPORT_RES.some((re) => re.test(line)) && [...imported].some((n) => new RegExp(String.raw`\b${n}\b`).test(line))
      const m = MEMBER_WRITE.exec(line) ?? (bare ? bare.exec(line) : null)
      if (isImportLine) add('s3', i, 'imports a write-capable fs function')
      else if (m) add('s3', i, `fs write call: ${m[1]}`)
    })
  }
  return findings
}

function matchesEntry(entry, rel) {
  return entry.path.endsWith('/') ? rel.startsWith(entry.path) : rel === entry.path
}

/** Scan `root`. Returns { filesScanned, findings, allowlisted, problems }. */
export function scan({ root = ROOT, allowlist = ALLOWLIST } = {}) {
  const problems = []
  const findings = []
  const allowlisted = []
  let filesScanned = 0

  for (const e of allowlist) {
    if (!e.reason || !e.residual) problems.push(`allowlist entry ${e.path} has no reason or no residual`)
  }
  for (const r of SCAN_ROOTS) {
    const abs = join(root, r)
    if (!existsSync(abs)) {
      problems.push(`scan root ${r} does not exist under ${root}`)
      continue
    }
    for (const file of walk(abs, [])) {
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
    if (e.reason && e.residual && !allowlisted.some((a) => a.entry === e.path)) {
      problems.push(`allowlist entry ${e.path} is stale: it matches no fs write — remove it`)
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
