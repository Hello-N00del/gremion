#!/usr/bin/env node
// Tree guard: fails if a known-compromised credential (by SHA-256 digest)
// appears anywhere in the tracked working tree.
//
//   node scripts/ci-local/known-secrets.mjs --repo <path>
//   node --test scripts/ci-local/known-secrets.test.mjs
//
// TASK-012 §5 Q2: the kernel had no digest denylist at all — StuRaOS's
// scripts/check-no-known-secrets.mjs is the only copy, and the kernel must
// not import from the product (open-core boundary: dependency direction is
// kernel -> product, never the reverse). This file PORTS that scanner's
// mechanism (a SHA-256 digest denylist, checked against every token-shaped
// substring of every tracked text file) rather than the product's own
// incident table — the kernel has no incidents recorded yet, so
// KNOWN_COMPROMISED starts empty. guards.mjs runs this same file against
// BOTH repos; running it against StuRaOS does not require reading StuRaOS's
// code, only its tracked files as bytes.
//
// THE SECRET IS NOT STORED HERE — IN ANY ENCODING. A denylist entry is a
// digest plus a note; nothing in this file can recover a plaintext credential
// from a digest. Rotating a leaked credential means adding its digest, never
// its value in any encoding (not base64, not split across a template
// literal) — see the StuRaOS guard's own header for the base64 revision that
// nearly re-leaked its fixture, and scripts/ci-local/known-secrets.test.mjs
// proves the mechanism with an injected SYNTHETIC sentinel for exactly that
// reason.
//
// There is no allowlist for this rule, ever, on any path. A digest match is
// hashed-equality against a known-bad value; the only way to suppress it
// short of a SHA-256 preimage is to remove the credential from the tree.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Kernel incident table. Empty today — add an entry the same way StuRaOS's
// scripts/check-no-known-secrets.mjs does, the day the kernel has one.
export const KNOWN_COMPROMISED = new Map()

// Token shapes worth hashing — wide on purpose: a credential can appear bare,
// in a URI, in YAML, or as a shell default.
const TOKEN_RE = /[A-Za-z0-9+/=_.~-]{8,400}/g

function candidates(raw) {
  const out = new Set([raw])
  for (const piece of raw.split(/[=:/@,;|]+/)) out.add(piece)
  for (const piece of raw.split(/[=:/@,;|_.~-]+/)) out.add(piece)
  return [...out].filter((c) => c.length >= 8)
}

const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|xz|woff2?|ttf|eot|mp4|webm|wasm|exe|dll|so|dylib|jar|class|keystore)$/i
const LOCKFILE = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|go\.sum)$/

/**
 * @param relPath  repo-relative path, reported in findings only
 * @param text     file contents
 * @param denylist digest -> note. Injectable so the test proves the digest
 *                 path with a synthetic sentinel instead of a real credential.
 */
export function scanText(relPath, text, denylist = KNOWN_COMPROMISED) {
  const findings = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const seen = new Set()
    for (const m of lines[i].matchAll(TOKEN_RE)) {
      for (const cand of candidates(m[0])) {
        const digest = createHash('sha256').update(cand).digest('hex')
        const note = denylist.get(digest)
        if (note && !seen.has(digest)) {
          seen.add(digest)
          findings.push({ rule: 'known-compromised', file: relPath, line: i + 1, detail: note })
        }
      }
    }
  }
  return findings
}

/**
 * Tracked FILES (repo-relative), excluding submodule gitlinks (mode
 * 160000): a gitlink is a commit pointer, not content — on disk it is a
 * directory (or nothing, when the submodule is not initialised), and the
 * submodule's own tree is scanned as its own repo if at all.
 */
export function trackedFiles(repoRoot) {
  const out = execFileSync('git', ['-C', repoRoot, 'ls-files', '-s', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const files = []
  for (const entry of out.split('\0')) {
    if (!entry) continue
    const tab = entry.indexOf('\t')
    const mode = entry.slice(0, entry.indexOf(' '))
    if (mode === '160000') continue
    files.push(entry.slice(tab + 1))
  }
  return files
}

/**
 * Load an EXTRA denylist from a JSON file of `{ "<sha256-hex>": "<note>" }`
 * entries and merge it with a base denylist (default `KNOWN_COMPROMISED`).
 * This is what lets a caller (guards.mjs's `--known-secrets-denylist`, or a
 * test) prove the entry point actually goes RED on an injected sentinel
 * digest without editing this file's source — the kernel's own
 * KNOWN_COMPROMISED starts empty (TASK-012 §5 Q2: the kernel has no
 * incidents recorded yet), so without an injection point the arm could never
 * be observed failing at the entry point at all, only by unit-testing
 * `scanText`/`scanRepo` directly.
 */
export function loadDenylistFile(path, base = KNOWN_COMPROMISED) {
  const merged = new Map(base)
  if (!path) return merged
  const entries = JSON.parse(readFileSync(path, 'utf8'))
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new Error(`known-secrets: denylist ${path} must be a JSON object of {"<sha256-hex>": "<note>"}`)
  }
  for (const [digest, note] of Object.entries(entries)) {
    // A key that is not a lower-case SHA-256 hex digest can never match
    // (scanText looks up createHash(...).digest('hex')), so a typo or a
    // pasted plaintext would silently protect nothing. Refuse it.
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`known-secrets: denylist ${path} has a key that is not a lower-case 64-hex SHA-256 digest (entry ${Object.keys(entries).indexOf(digest) + 1})`)
    }
    if (typeof note !== 'string' || note.length === 0) {
      throw new Error(`known-secrets: denylist ${path} entry ${Object.keys(entries).indexOf(digest) + 1} needs a non-empty note`)
    }
    merged.set(digest, note)
  }
  return merged
}

export function scanRepo(repoRoot, denylist = KNOWN_COMPROMISED) {
  const files = trackedFiles(repoRoot)

  // A scan that collected zero files "passes". Refuse to be that guard.
  if (files.length === 0) {
    throw new Error(`known-secrets: collected 0 tracked files under ${repoRoot} — refusing to report a green scan`)
  }

  const findings = []
  let scanned = 0
  for (const rel of files) {
    if (BINARY_EXT.test(rel) || LOCKFILE.test(rel)) continue
    let text
    try {
      text = readFileSync(join(repoRoot, rel), 'utf8')
    } catch (err) {
      // Only a tracked file deleted in the worktree is skipped silently: it
      // cannot be scanned and holds nothing on disk. Any other read error
      // (permissions, a directory where a file was, I/O) would drop a file
      // from the scan with no trace, so it fails the scan instead (MEDIUM
      // fix: every error used to be skipped silently).
      if (err?.code === 'ENOENT') continue
      throw new Error(`known-secrets: could not read tracked file ${rel}: ${err?.code ?? err?.message} — refusing to report a scan that skipped it`)
    }
    if (text.includes('\0')) continue // binary
    scanned++
    findings.push(...scanText(rel, text, denylist))
  }

  if (scanned === 0) {
    throw new Error('known-secrets: scanned 0 text files — refusing to report a green scan')
  }
  return { findings, scanned, tracked: files.length }
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i === -1 ? null : argv[i + 1]
}

export function main(argv = process.argv.slice(2)) {
  const repoArg = argValue(argv, '--repo')
  const repoRoot = repoArg
    ? execFileSync('git', ['-C', repoArg, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    : execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

  const { findings, scanned } = scanRepo(repoRoot)

  if (findings.length > 0) {
    console.error(`\nKNOWN-SECRETS GUARD FAILED (${repoRoot}) — ${findings.length} finding(s):\n`)
    for (const f of findings) {
      console.error(`  [${f.rule}] ${f.file}:${f.line}`)
      console.error(`      ${f.detail}\n`)
    }
    console.error('A known-compromised credential must be removed from the tree AND rotated by the operator.\n')
    process.exitCode = 1
    return
  }

  console.log(`known-secrets: OK (${repoRoot}) — ${scanned} tracked text files scanned, 0 findings`)
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('known-secrets.mjs')) {
  main()
}
