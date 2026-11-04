#!/usr/bin/env node
// Node runtime floor guard for every Dockerfile in the tree.
//
// The official node images bundle their own copy of Brotli, OpenSSL, llhttp and
// undici, so a Node security release reaches a container only through its base
// image. A digest pin freezes that base for good: kernel-api sat on a May 2026
// image (Node 26.2.0) for five months, through CVE-2026-111497 (Broccoli2Shell,
// Brotli decoder out-of-bounds write, CISA KEV), and nothing noticed.
//
// Rules, per `FROM node...` line:
//   1. A digest-pinned ref must name its full x.y.z version in the tag
//      (`node:26.13.0-alpine@sha256:...`), and that version must be at or above
//      the floor of its major. A digest alone states no version this guard can
//      read, so it fails.
//   2. A tag-pinned full version must be at or above its floor too.
//   3. A floating major tag (`node:26-alpine`) passes: the registry moves it to
//      the newest release of that line, which is above the floor once the
//      floor's release is out. The image still has to be REBUILT to pick it up.
//   4. A major with no floor in NODE_FLOORS fails: an end-of-life line gets no
//      security releases, and a new line has not been looked at yet.
//   5. No tag, `latest`, `lts`, `current` or a codename fails: unreadable input
//      never passes.
//
// LIMIT. The guard reads the tag, not the digest. It cannot tell that a tag says
// 26.13.0 while the digest is an older image; keep the two in step by taking
// both from the registry at once (the `Digest:` of `docker buildx imagetools
// inspect node:<x.y.z>-alpine`, the multi-arch INDEX digest).
//
// NOT SCANNED, bump by hand with every floor raise: VENDOR_MAIL_NODE_IMAGE in
// infra/host/templates/env/mail.env.tmpl (and its ops/vendor-mail fixture),
// digest-only by TRD-350 so it states no version, and the NODEIMAGE /
// NODE_IMAGE helper pins in services/kernel-api/test/bodies/image-proof.sh,
// services/kernel-api/test/harness/stack-proof.sh and
// test/host/integration/customer-provision-proof.sh.
//
// Run:  node scripts/check-node-floor.mjs [--root DIR]   (wired into `make lint`)
// Test: node --test scripts/check-node-floor.test.mjs

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions } from './check-cve-floors.mjs'

// ── the committed floor table ──────────────────────────────────────────────
//
// One entry per supported Node major. `floor` is the FIRST release that carries
// every security fix we hold the line to; raising it is what makes this guard go
// RED on an image that has not kept up.

export const NODE_FLOORS = {
  22: {
    floor: '22.23.4',
    advisory: 'CVE-2026-111497 (Broccoli2Shell, bundled Brotli decoder OOB write, CISA KEV) — Node October 2026 security release',
  },
  24: {
    floor: '24.22.1',
    advisory: 'CVE-2026-111497 (Broccoli2Shell, bundled Brotli decoder OOB write, CISA KEV) — Node October 2026 security release',
  },
  26: {
    floor: '26.12.1',
    advisory: 'CVE-2026-111497 (Broccoli2Shell, bundled Brotli decoder OOB write, CISA KEV) — Node October 2026 security release',
  },
}

// ── parsing ────────────────────────────────────────────────────────────────

// FROM [--platform=...] <ref> [AS name]; the ref names the official node image
// in any of its spellings.
const FROM = /^\s*FROM\s+(?:--\S+\s+)*(\S+)/i
// Any registry host (docker.io, index.docker.io, a pull-through mirror) in front.
const NODE_REPO = /^(?:[\w.-]+\.[\w.-]+(?::\d+)?\/)?(?:library\/)?node$/

/** Every `FROM node...` line in a Dockerfile: { line, ref, tag, digest }. */
export function parseNodeFroms(text) {
  const out = []
  String(text)
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const m = raw.match(FROM)
      if (!m) return
      const ref = m[1]
      const [nameTag, digest = null] = ref.split('@')
      const colon = nameTag.lastIndexOf(':')
      const name = colon === -1 ? nameTag : nameTag.slice(0, colon)
      const tag = colon === -1 ? null : nameTag.slice(colon + 1)
      if (!NODE_REPO.test(name)) return
      out.push({ line: i + 1, ref, tag, digest })
    })
  return out
}

// ── checks ─────────────────────────────────────────────────────────────────

/** Problems for one Dockerfile's node bases. */
export function checkDockerfile(path, text, floors = NODE_FLOORS) {
  const problems = []
  for (const f of parseNodeFroms(text)) {
    const at = `${path}:${f.line} ${f.ref}`
    const full = f.tag?.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-|$)/)
    const major = full ? full[1] : f.tag?.match(/^v?(\d+)(?:[.-]|$)/)?.[1]
    if (!major) {
      problems.push(`${at}: no numeric Node version in the tag — untagged, latest, lts and codenames are unreadable`)
      continue
    }
    const entry = floors[major]
    if (!entry) {
      problems.push(`${at}: Node ${major} has no floor in NODE_FLOORS — an end-of-life line gets no security releases`)
      continue
    }
    if (!full) {
      if (f.digest) {
        problems.push(`${at}: digest-pinned but the tag states no x.y.z version, so its Node version is unreadable — pin as node:<x.y.z>-<variant>@sha256:...`)
        continue
      }
      // A major.minor tag floats only within its minor line, so a minor below
      // the floor's never reaches the patched release.
      const minor = f.tag.match(/^v?\d+\.(\d+)(?:-|$)/)?.[1]
      const floorMinor = entry.floor.split('.')[1]
      if (minor !== undefined && Number(minor) < Number(floorMinor)) {
        problems.push(`${at}: the Node ${major}.${minor} line is BELOW the floor ${entry.floor} and never reaches it — ${entry.advisory}`)
      }
      continue
    }
    const version = `${full[1]}.${full[2]}.${full[3]}`
    if (compareVersions(version, entry.floor) < 0) {
      problems.push(`${at}: Node ${version} is BELOW the floor ${entry.floor} — ${entry.advisory}`)
    }
  }
  return problems
}

/** Dockerfile, Dockerfile.<x>, <x>.Dockerfile and Containerfile names. */
export function isDockerfile(path) {
  return /^(?:(?:Dockerfile|Containerfile)(?:\.(?!md$)[\w.-]+)?|[\w.-]+\.Dockerfile)$/.test(basename(path))
}

/** Every tracked Dockerfile under root (git ls-files; fails on a git error). */
function trackedDockerfiles(root) {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ls-files failed in ${root}: ${r.error?.message ?? r.stderr}`)
  return r.stdout.split('\0').filter((p) => p && isDockerfile(p))
}

/** Every check, against a checked-out repo root. */
export function runChecks(root) {
  const problems = []
  let scanned = 0
  for (const path of trackedDockerfiles(root)) {
    const text = readFileSync(join(root, path), 'utf8')
    scanned += parseNodeFroms(text).length
    problems.push(...checkDockerfile(path, text))
  }
  if (scanned === 0) problems.push('no node FROM line found in any tracked Dockerfile — the scan is vacuous')
  return { problems, scanned }
}

// ── CLI ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const i = process.argv.indexOf('--root')
  const root = i !== -1 ? process.argv[i + 1] : join(dirname(fileURLToPath(import.meta.url)), '..')
  const { problems, scanned } = runChecks(root)
  if (problems.length > 0) {
    console.error(`[node-floor] ${problems.length} problem(s):`)
    for (const p of problems) console.error(`  x ${p}`)
    process.exit(1)
  }
  console.log(`[node-floor] OK — ${scanned} node FROM line(s) at or above their floors`)
}
