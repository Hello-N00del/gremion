#!/usr/bin/env node
// TASK-015 (TRD-253, Q7): the vendor mail server is the UPSTREAM Stalwart
// image, unmodified, pinned by digest -- the premise of the "no AGPL section 13
// offer" statement in docs/compliance/vendor-mail-licence.md.
//
//   node ops/vendor-mail/check-upstream-image.mjs          # verify (repository)
//   (via the launcher on a host, VENDOR_MAIL_MODE=host: the scoped files only)
//
// Scoped to the vendor mail project (the generic TRD-350 pinning of every
// image is TASK-048's):
//   * mail.env.tmpl STALWART_IMAGE = docker.io/stalwartlabs/stalwart@sha256:<64>
//     and VENDOR_MAIL_NODE_IMAGE = docker.io/library/node@sha256:<64>;
//   * infra/host/mail/docker-compose.yml: no `build:`, and its only image is
//     ${STALWART_IMAGE:?...};
//   * (verify) the licence register row and vendor-mail-licence.md name the
//     same digest: an image bump without a licence re-read fails;
//   * (verify) every other tracked, non-Markdown reference to a Stalwart image
//     is that digest form, except the NAMED exclusions below, each of which
//     fails as soon as it is stale (its line is gone).
//
// EXIT: 0 upstream and pinned - 1 not - 2 unreadable input.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { envMap, REPO_ROOT } from './lib/env.mjs'

export const STALWART_RE = /^docker\.io\/stalwartlabs\/stalwart@sha256:[0-9a-f]{64}$/
export const NODE_RE = /^docker\.io\/library\/node@sha256:[0-9a-f]{64}$/
export const COMPOSE_IMAGE_LINE = 'image: ${STALWART_IMAGE:?STALWART_IMAGE required}'

export const EXCLUSIONS = [
  {
    file: 'test/host/integration/pooled-stack-proof.sh',
    line: 'STALWART_IMAGE=stalwartlabs/stalwart:v0.16.21',
    why: 'the TASK-040 scratch proof boots v0.16.21 BY TAG against the v0.15 config: a note for TASK-048b / TASK-040-FU, not a production reference',
  },
  {
    file: 'test/host/fixtures/pooled-stack/mail.env',
    line: 'STALWART_IMAGE=docker.io/stalwartlabs/stalwart:fixture',
    why: 'the pooled-stack render fixture; `docker compose config` never pulls it',
  },
  {
    // line: null = the whole file. Stale once the file references no
    // Stalwart image at all.
    file: 'scripts/release/check-image-digests.test.mjs',
    line: null,
    why: "TASK-048's digest-lint tests seed tag and partial Stalwart references on purpose; that guard (TRD-350) pins every deployed image, and no production file is here",
  },
]

/** Image-shaped references to Stalwart in a line (a URL is a link, not an image). */
export function stalwartRefs(line) {
  return [...line.matchAll(/(?<![\w./-])((?:[a-z0-9.-]+(?::\d+)?\/)?stalwartlabs\/stalwart(?![\w-])[A-Za-z0-9._:@/-]*)/g)]
    .map((m) => m[1])
    .filter((r) => !/^(github\.com|raw\.githubusercontent\.com|www\.)/.test(r))
    .filter((r) => !line.slice(0, line.indexOf(r)).match(/https?:\/\/[^\s]*$/))
}

export function scopedViolations({ mailTmpl, compose }) {
  const out = []
  const env = envMap(mailTmpl, 'mail.env.tmpl')
  if (!STALWART_RE.test(env.STALWART_IMAGE ?? '')) out.push(`mail.env.tmpl STALWART_IMAGE is ${env.STALWART_IMAGE ?? 'absent'}: it must be docker.io/stalwartlabs/stalwart@sha256:<64 hex> (upstream, by digest)`)
  if (!NODE_RE.test(env.VENDOR_MAIL_NODE_IMAGE ?? '')) out.push(`mail.env.tmpl VENDOR_MAIL_NODE_IMAGE is ${env.VENDOR_MAIL_NODE_IMAGE ?? 'absent'}: it must be docker.io/library/node@sha256:<64 hex>`)
  const lines = compose.split(/\r?\n/)
  lines.forEach((l, i) => {
    if (/^\s*build\s*:/.test(l)) out.push(`infra/host/mail/docker-compose.yml:${i + 1} builds an image (build:): the vendor mail server is the upstream image, unmodified`)
  })
  const images = lines.map((l, i) => [l.trim(), i + 1]).filter(([l]) => /^image\s*:/.test(l))
  if (images.length !== 1 || images[0][0] !== COMPOSE_IMAGE_LINE) {
    out.push(`infra/host/mail/docker-compose.yml: the only image line must be "${COMPOSE_IMAGE_LINE}", found ${images.map(([l, n]) => `${n}: ${l}`).join(' | ') || 'none'}`)
  }
  return { out, digest: (env.STALWART_IMAGE ?? '').split('@')[1] ?? null }
}

export function licenceViolations({ digest, register, statement }) {
  const out = []
  const row = register.split(/\r?\n/).find((l) => l.startsWith('| Stalwart (vendor mail server) |'))
  if (!row) out.push('docs/compliance/licence-register.md has no "Stalwart (vendor mail server)" row (TASK-005 procedure, section 4)')
  else if (!digest || !row.includes(digest)) out.push('the licence register row does not name the STALWART_IMAGE digest: re-read the licence for the new image (register rule 3)')
  if (!digest || !statement.includes(digest)) out.push('docs/compliance/vendor-mail-licence.md does not name the STALWART_IMAGE digest')
  if (!/\|\s*licensed_edition\s*\|\s*`unmodified`\s*\|/.test(statement)) out.push('docs/compliance/vendor-mail-licence.md does not state licensed_edition `unmodified`')
  return out
}

/** @param {Array<{file: string, line: number, text: string}>} hits */
export function treeViolations(hits, files = {}) {
  const out = []
  const used = new Set()
  for (const h of hits) {
    for (const ref of stalwartRefs(h.text)) {
      if (STALWART_RE.test(ref)) continue
      const ex = EXCLUSIONS.find((e) => e.file === h.file && (e.line === null || h.text.trim() === e.line))
      if (ex) {
        used.add(ex.file)
        continue
      }
      out.push(`${h.file}:${h.line} references the Stalwart image as ${ref}, not by digest`)
    }
  }
  for (const e of EXCLUSIONS) {
    const text = files[e.file]
    if (e.line === null) {
      const present = text !== undefined ? text.includes('stalwartlabs/stalwart') : used.has(e.file)
      if (!present) out.push(`stale exclusion: ${e.file} no longer references a Stalwart image -- remove it from check-upstream-image.mjs EXCLUSIONS`)
      continue
    }
    const present = text !== undefined ? text.split(/\r?\n/).some((l) => l.trim() === e.line) : used.has(e.file)
    if (!present) out.push(`stale exclusion: ${e.file} no longer carries "${e.line}" -- remove it from check-upstream-image.mjs EXCLUSIONS`)
  }
  return out
}

/**
 * `git grep -n` output -> hits. CRLF line ends (a checkout with
 * core.autocrlf) are stripped; a line that is not <file>:<n>:<text> is a named
 * error (the caller reports it as unparseable), never a TypeError.
 */
export function parseGitGrep(txt) {
  return txt
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const m = /^([^:]+):(\d+):(.*)$/.exec(l)
      if (!m) throw new Error(`unparseable git grep line: ${l.slice(0, 120)}`)
      return { file: m[1], line: Number(m[2]), text: m[3] }
    })
}

function gitHits(root) {
  return parseGitGrep(execFileSync('git', ['grep', '-n', '-I', '-E', 'stalwartlabs/stalwart', '--', '.', ':!*.md', ':!ops/vendor-mail/**'], { cwd: root, encoding: 'utf8' }))
}

export function main({ root = REPO_ROOT, host = process.env.VENDOR_MAIL_MODE === 'host', log = console } = {}) {
  let r
  const read = (p) => readFileSync(path.join(root, p), 'utf8')
  try {
    r = scopedViolations({ mailTmpl: read('infra/host/templates/env/mail.env.tmpl'), compose: read('infra/host/mail/docker-compose.yml') })
  } catch (e) {
    log.error(`UNPARSEABLE ${e.code ?? ''} ${e.message}`)
    return 2
  }
  const out = [...r.out]
  if (!host) {
    try {
      out.push(...licenceViolations({ digest: r.digest, register: read('docs/compliance/licence-register.md'), statement: read('docs/compliance/vendor-mail-licence.md') }))
      const files = Object.fromEntries(EXCLUSIONS.map((e) => [e.file, (() => { try { return read(e.file) } catch { return '' } })()]))
      out.push(...treeViolations(gitHits(root), files))
    } catch (e) {
      log.error(`UNPARSEABLE ${e.code ?? ''} ${e.message}`)
      return 2
    }
  }
  for (const v of out) log.error(`FAIL ${v}`)
  log.log(`UPSTREAM-IMAGE: mode=${host ? 'host' : 'verify'} digest=${r.digest ?? 'none'} violations=${out.length}`)
  return out.length ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
