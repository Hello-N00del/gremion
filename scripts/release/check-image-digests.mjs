#!/usr/bin/env node
// check-image-digests — every container image a deployment manifest names is
// pinned by content digest (TRD-350, raw arm), and no object-storage component,
// profile, key or client remains (TRD-066, TRD-354). TASK-048.
//
// SCAN SET. Discovered, never listed: SCAN_PATTERNS are repository-top-anchored
// `git ls-files` pathspecs, so a new compose file under compose/** or infra/**
// is scanned the day it is committed, and test fixtures, packages/**, k8s/**
// and .github/** are outside by construction (Q1). A file may be left out only
// through scripts/release/image-scan-exclusions.json, each entry a glob that
// matches a discovered file plus a reason; an entry without a reason, or one
// that matches nothing discovered, fails. Exclusions apply to the raw arm only.
//
// RAW ARM. Every `image:` (YAML), every `*_IMAGE=` assignment and every
// `${*_IMAGE:-default}` must read <repo>[:tag]@sha256:<64 hex>. The one
// exception is a first-party ref (registry exactly ghcr.io, namespace exactly
// hello-n00del, compared component by component, so a lookalike is
// third-party) of the form :${IMAGE_TAG:-dev} or :${IMAGE_TAG:?...} on a
// service that has `build:` — the release pins layer swaps it for a digest.
// Before anything is resolved, the literal default of every ${VAR:-d} and
// ${VAR-d} is checked on its own: `latest` fails everywhere (a template value
// such as IMAGE_TAG=CHANGE_ME_... would otherwise hide it). Other ${VAR}s are
// resolved against the project's env template (PROJECT_ENV); a variable with
// no template value and no default fails. An image declaration that is not the
// canonical `<indent>image: <ref>` form fails, as gremion-deploy's stray check
// refuses it at deploy time.
//
// OBJECT-STORAGE ARM. Fails on a minio image repository (minio/*, quay.io/
// minio/*, any repository with a `minio` path component), a compose service
// named minio, an `object-storage` profile, a MINIO_* or *_S3_* key (assigned
// or expanded) anywhere in the scan set, and minio or @aws-sdk/client-s3 in
// pnpm-lock.yaml (a pilot-scoped proxy for "no tenant data depends on an
// S3-compatible store"). There is no exclusion for this arm.
//
// Unreadable input is a failure, never a pass: zero discovered files, a git
// that cannot list the tree, an unreadable exclusions file or lockfile.
//
// Run:   node scripts/release/check-image-digests.mjs [--root DIR]
//        node scripts/release/check-image-digests.mjs --third-party-list
//          (prints the canonical non-first-party repositories, one per line,
//          for the host's $ROOT/etc/third-party-images; refuses on a RED tree)
// Test:  node --test scripts/release/check-image-digests.test.mjs
// Make:  make lint-image-digests

import { readFileSync, existsSync } from 'node:fs'
import { join, matchesGlob, posix } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const SCAN_PATTERNS = Object.freeze([
  ':(top,glob)docker-compose*.yml',
  ':(top,glob)docker-compose*.yaml',
  ':(top,glob)compose*.yml',
  ':(top,glob)compose*.yaml',
  ':(top,glob)compose/**/*.yml',
  ':(top,glob)compose/**/*.yaml',
  ':(top,glob)infra/**/docker-compose*.yml',
  ':(top,glob)infra/**/docker-compose*.yaml',
  ':(top,glob)infra/**/values.yaml',
  ':(top,glob)infra/host/templates/env/*.tmpl',
  ':(top,glob)infra/host/bin/*',
  ':(top)infra/host/bootstrap.sh',
  ':(top,glob)infra/host/lib/*.sh',
  ':(top).env.example',
])

export const EXCLUSIONS_FILE = 'scripts/release/image-scan-exclusions.json'
export const LOCKFILE = 'pnpm-lock.yaml'
export const FIRST_PARTY = Object.freeze({ registry: 'ghcr.io', namespace: 'hello-n00del' })

// Which env template a compose project resolves its ${VAR}s from (TASK-040's
// project split). A discovered file not named here has no template, so any
// ${VAR} in it without a literal default is unresolvable.
export const PROJECT_ENV = Object.freeze({
  'docker-compose.yml': 'infra/host/templates/env/state.env.tmpl',
  'docker-compose.prod.yml': 'infra/host/templates/env/state.env.tmpl',
  'docker-compose.override.yml': 'infra/host/templates/env/state.env.tmpl',
  'docker-compose.app.yml': 'infra/host/templates/env/app.env.tmpl',
  'docker-compose.app.dev.yml': 'infra/host/templates/env/app.env.tmpl',
  'infra/host/ops/docker-compose.yml': 'infra/host/templates/env/ops.env.tmpl',
  'infra/host/mail/docker-compose.yml': 'infra/host/templates/env/mail.env.tmpl',
})

// <repo>[:tag]@sha256:<64 hex>, repo in docker reference grammar (lowercase
// path components, optional registry host[:port]).
const COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*'
const REPO = `(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::[0-9]+)?/)?${COMPONENT}(?:/${COMPONENT})*`
const PINNED_RE = new RegExp(`^(${REPO})(?::([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?@sha256:[0-9a-f]{64}$`)
const TAGGED_RE = new RegExp(`^(${REPO})(?::([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?$`)
const FIRST_PARTY_TAG_RE = new RegExp(
  `^${FIRST_PARTY.registry.replace(/\./g, '\\.')}/${FIRST_PARTY.namespace}/${COMPONENT}(?:/${COMPONENT})*:\\$\\{IMAGE_TAG(?::-dev|:\\?[^}]*)\\}$`,
)
// ${VAR}, ${VAR:-d}, ${VAR-d}, ${VAR:=d}, ${VAR:?m}, ${VAR?m}, $VAR
const EXPANSION_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?=])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g
const DEFAULT_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-=])([^}]*)\}/g
// A `latest` default anywhere, nested defaults included (${T:-${U:-latest}}).
const LATEST_DEFAULT_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*:?[-=]["']?(?:[^}"'\s]*:)?latest["']?\}/
// An image variable: IMAGE or *_IMAGE.
const IMAGE_VAR_RE = /(^|_)IMAGE$/
// Every IMAGE / *_IMAGE assignment on a shell or env line (several per line,
// behind export/local/readonly/typeset/declare).
const IMAGE_ASSIGN_G = /(?:^|[\s;])(?:(?:export|local|readonly|typeset|declare(?:\s+-\w+)*)\s+)?((?:[A-Za-z_][A-Za-z0-9_]*_)?IMAGE)=("[^"]*"|'[^']*'|[^\s;#]*)/g
// ...and in a compose environment list or map.
const YAML_IMAGE_ENV_RE = /^\s*(?:-\s+["']?((?:[A-Za-z_][A-Za-z0-9_]*_)?IMAGE)=(.*?)["']?|["']?((?:[A-Za-z_][A-Za-z0-9_]*_)?IMAGE)["']?:\s*(.+))\s*$/
const IMAGE_TAG_ASSIGN_RE = /^\s*(?:(?:export|local|readonly)\s+)?((?:[A-Za-z_][A-Za-z0-9_]*_)?IMAGE_TAG)=(.*)$/
// A value is plain reference characters and whole ${...} expansions (whose
// :?message may hold spaces); a flow mapping, a trailing token, a quoted key
// or an unbalanced brace is not canonical.
const CANONICAL_IMAGE_LINE_RE = /^\s*image:\s*(["']?)((?:\$\{[^{}\n"']*\}|\$(?!\{)|[^\s"'{}#,[\]$])+)\1\s*$/
const IMAGE_KEY_RE = /(^|[\s{,])["']?image["']?\s*:/
// TRD-066/354 key definition (brief section 1), widened by review round 1 to
// keys that START with S3_ (S3_ENDPOINT), which the brief's \w*_S3_ misses.
const OS_ASSIGN_RE = /^\s*(export\s+)?(MINIO_\w*|(?:\w*_)?S3_\w*)=/
const OS_EXPANSION_RE = /\$\{?(MINIO_|(?:\w*_)?S3_)/
const OS_PROFILE_RE = /(^\s*profiles\s*:.*\bobject-storage\b)|(^\s*-\s*["']?object-storage["']?\s*$)|(COMPOSE_PROFILES=.*\bobject-storage\b)/
const OS_SERVICE_RE = /^ {2}["']?[A-Za-z0-9_.-]*minio[A-Za-z0-9_.-]*["']?\s*:/i
const OS_YAML_KEY_RE = /^\s*(?:-\s+)?["']?(MINIO_\w*|(?:\w*_)?S3_\w*)["']?\s*[:=]/
// A minio repository anywhere on a line (docker run, a default, an env value).
const OS_REF_RE = /(?:^|[\s="'@/:-])minio\/(?:minio|mc)(?=[\s:@"'/]|$)|quay\.io\/minio\/|(?:^|[\s="'])(?:docker\.io\/)?(?:library\/)?minio(?::[\w.-]+)?(?:@sha256:[0-9a-f]+)?(?=["'\s]|$)/
// YAML the line scan cannot read as YAML does: a line break other than \n or
// \r\n (go-yaml also breaks on a lone CR, NEL, LS and PS), and keys spelled
// in a form other than a plain word (explicit `? key`, an alias `*k :`, an
// escaped double-quoted key).
const YAML_BREAK_RE = /\r(?!\n)|\u0085|\u2028|\u2029/
const YAML_KEY_HAZARD_RE = /^\s*(?:-\s+)?(?:\?(?:\s|$)|\*[^\s:]+\s*:|"[^"]*\\[^"]*"\s*:)/
const NOT_A_BUILD_RE = /^(?:!reset(?:\s+null)?|null|~|""|'')?\s*$/
const OS_LOCK_RE = /^\s+['"]?(minio|@aws-sdk\/client-s3)(@[^:'"]+)?['"]?\s*:/

const isYaml = (f) => /\.ya?ml$/.test(f)
const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, '$2')

/** docker's canonical, tagless repository form (= gremion-deploy canonical_repo). */
export function canonicalRepo(ref) {
  let r = ref.replace(/@sha256:[0-9a-f]+$/, '')
  const m = /^(.+):[^/:]+$/.exec(r)
  if (m) r = m[1]
  const first = r.split('/')[0]
  if (!r.includes('/')) r = `docker.io/library/${r}`
  else if (!first.includes('.') && !first.includes(':') && first !== 'localhost') r = `docker.io/${r}`
  if (r.startsWith('index.docker.io/')) r = `docker.io/${r.slice('index.docker.io/'.length)}`
  if (/^docker\.io\/[^/]+$/.test(r)) r = `docker.io/library/${r.slice('docker.io/'.length)}`
  return r
}

/** First-party iff the registry and namespace components are exactly ours. */
export function isFirstParty(ref) {
  const parts = ref.split('/')
  return parts.length >= 3 && parts[0] === FIRST_PARTY.registry && parts[1] === FIRST_PARTY.namespace
}

/** Anything that names our registry host or namespace without being exactly first-party. */
export function isFirstPartyLookalike(ref) {
  if (isFirstParty(ref)) return false
  const parts = ref.toLowerCase().split('/')
  if (parts.length < 2) return false
  return parts[0].replace(/:\d+$/, '') === FIRST_PARTY.registry || parts.slice(0, -1).includes(FIRST_PARTY.namespace)
}

function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error || r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${root}: ${r.error?.message ?? r.stderr}`)
  return r.stdout
}

export function discover(root) {
  return git(root, ['ls-files', '-z', '--', ...SCAN_PATTERNS]).split('\0').filter(Boolean).sort()
}

function parseEnv(text) {
  const env = new Map()
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (m && !/^\s*#/.test(line)) env.set(m[1], unquote(m[2].replace(/\s+#.*$/, '')))
  }
  return env
}

function codeLines(text, yaml) {
  return text.split(/\r?\n/).map((raw, i) => {
    let line = /^\s*#/.test(raw) ? '' : raw
    if (yaml) line = line.replace(/\s+#.*$/, '')
    return { no: i + 1, raw, line }
  })
}

/** Is line `i` an `extends:` that names a file (flow or block form)? */
function isExtendsFile(lines, i) {
  const l = lines[i].line
  const m = /^(\s*)extends\s*:(.*)$/.exec(l)
  if (!m) return false
  if (/\bfile\s*:/.test(m[2])) return true
  if (m[2].trim()) return false
  const n = m[1].length
  for (let j = i + 1; j < lines.length; j++) {
    const x = lines[j].line
    if (!x.trim()) continue
    if (/^(\s*)/.exec(x)[1].length <= n) break
    if (/^\s*file\s*:/.test(x)) return true
  }
  return false
}

/** Does the YAML mapping holding line `i` (same indent) carry a build: key? */
function siblingHasBuild(lines, i) {
  const indentOf = (l) => /^(\s*)/.exec(l)[1].length
  const target = lines[i].line.replace(/^(\s*)-\s+/, '$1  ')
  const n = indentOf(target)
  const within = (j) => {
    const l = lines[j].line
    if (!l.trim()) return 'skip'
    const k = indentOf(l)
    if (k < n) return 'stop'
    return k === n ? 'sibling' : 'skip'
  }
  for (const dir of [-1, 1]) {
    for (let j = i + dir; j >= 0 && j < lines.length; j += dir) {
      const w = within(j)
      if (w === 'stop') break
      const b = /^\s*build\s*:(.*)$/.exec(lines[j].line)
      // `build: !reset null` (a pins layer), null, ~ or "" is NOT a build.
      if (w === 'sibling' && b) return !NOT_A_BUILD_RE.test(b[1].trim()) || b[1].trim() === ''
    }
  }
  return false
}

/**
 * Judge one image reference. Returns {problem?: {code, message}, resolved?}.
 * ctx: {env: Map|null, build: boolean}
 */
export function judgeRef(raw, ctx) {
  const ref = unquote(raw)
  // 1. literal defaults, before any resolution.
  for (const m of ref.matchAll(DEFAULT_RE)) {
    const d = unquote(m[3])
    if (d === 'latest' || /:latest$/.test(d)) {
      return { problem: { code: 'latest', message: `literal default '${d}' in ${ref} (latest fails everywhere)` } }
    }
    if (IMAGE_VAR_RE.test(m[1]) && !PINNED_RE.test(d)) {
      return { problem: { code: 'unpinned', message: `default of \${${m[1]}} is not <repo>[:tag]@sha256:<64 hex>: '${d}'` } }
    }
  }
  // 2. the first-party build exception.
  if (FIRST_PARTY_TAG_RE.test(ref)) {
    if (ctx.build) return { resolved: null }
    return { problem: { code: 'first-party-no-build', message: `${ref}: a first-party tag ref is allowed only on a service with build:` } }
  }
  // 3. resolve against the project's env template.
  let unresolved = null
  const resolved = ref.replace(EXPANSION_RE, (whole, name, op, arg, bare) => {
    const v = name ?? bare
    const fromEnv = ctx.env?.get(v)
    if (fromEnv !== undefined && !((op === ':-' || op === ':=') && fromEnv === '')) return fromEnv
    if (op === ':-' || op === '-' || op === ':=' || op === '=') return unquote(arg ?? '')
    unresolved ??= v
    return whole
  })
  if (unresolved) return { problem: { code: 'unresolvable', message: `\${${unresolved}} in ${ref} resolves from no env template and has no default` } }
  const pin = PINNED_RE.exec(resolved)
  if ((pin ?? TAGGED_RE.exec(resolved))?.[2] === 'latest') return { problem: { code: 'latest', message: `${resolved}: a :latest tag` } }
  if (!pin) {
    return { problem: { code: 'unpinned', message: `not <repo>[:tag]@sha256:<64 hex>: ${ref}${resolved !== ref ? ` (resolves to ${resolved})` : ''}` } }
  }
  return { resolved }
}

function loadExclusions(root, problems) {
  const p = join(root, EXCLUSIONS_FILE)
  let doc
  try {
    doc = JSON.parse(readFileSync(p, 'utf8'))
  } catch (err) {
    problems.push({ code: 'exclusions-unreadable', where: EXCLUSIONS_FILE, message: err.message })
    return null
  }
  if (!doc || !Array.isArray(doc.exclusions)) {
    problems.push({ code: 'exclusions-unreadable', where: EXCLUSIONS_FILE, message: 'expected {"exclusions": [{glob, reason}]}' })
    return null
  }
  return doc.exclusions
}

/** Scan a repository. Returns {files, refs, problems, thirdParty}. */
export function checkTree(root) {
  const problems = []
  const add = (code, where, message) => {
    if (!problems.some((p) => p.code === code && p.where === where)) problems.push({ code, where, message })
  }
  let files
  try {
    files = discover(root)
  } catch (err) {
    add('no-files', '.', err.message)
    return { files: [], refs: 0, problems, thirdParty: [] }
  }
  if (!files.length) add('no-files', '.', `no file matches the scan set (${SCAN_PATTERNS.join(' ')})`)

  const exclusions = loadExclusions(root, problems) ?? []
  const excluded = new Set()
  for (const [i, e] of exclusions.entries()) {
    const where = `${EXCLUSIONS_FILE}[${i}]`
    if (!e || typeof e.glob !== 'string' || !e.glob.trim()) {
      add('exclusion-no-glob', where, 'an exclusion needs a glob')
      continue
    }
    if (typeof e.reason !== 'string' || !e.reason.trim()) add('exclusion-no-reason', where, `${e.glob}: an exclusion needs a reason`)
    const hit = files.filter((f) => matchesGlob(f, e.glob))
    if (!hit.length) add('exclusion-stale', where, `${e.glob} matches no discovered file`)
    if (hit.length > 1) add('exclusion-broad', where, `${e.glob} matches ${hit.length} files; an exclusion names exactly one`)
    for (const f of hit) excluded.add(f)
  }

  const envCache = new Map()
  const envFor = (f) => {
    const tmpl = PROJECT_ENV[f]
    if (!tmpl) return null
    if (!envCache.has(tmpl)) {
      const p = join(root, tmpl)
      envCache.set(tmpl, existsSync(p) ? parseEnv(readFileSync(p, 'utf8')) : null)
    }
    return envCache.get(tmpl)
  }

  // Every COMPOSE_FILE component a template names is a file this scan reads
  // (relative to its project directory), bar the release pins layer, which is
  // never committed and is judged by check-pins.mjs and gremion-deploy.
  // `files` holds git's forward-slash paths, so the component resolves with
  // posix join/normalize on every OS (the platform ones give `\` on Windows).
  const tmplDirs = new Map()
  for (const [compose, tmpl] of Object.entries(PROJECT_ENV)) tmplDirs.set(tmpl, posix.dirname(compose))
  const checkComposeFile = (f, text) => {
    for (const [i, line] of text.split(/\r?\n/).entries()) {
      const m = /^\s*(?:export\s+)?COMPOSE_FILE=(.*)$/.exec(line)
      if (!m) continue
      for (const c of unquote(m[1].replace(/\s+#.*$/, '')).split(':').filter(Boolean)) {
        if (c.split('/').pop() === 'docker-compose.pins.yml') continue
        const p = posix.normalize(posix.join(tmplDirs.get(f) ?? '.', c))
        if (!files.includes(p)) add('compose-file-unscanned', `${f}:${i + 1}`, `COMPOSE_FILE names ${c} (${p}), which the scan set does not discover`)
      }
    }
  }

  let refs = 0
  const thirdParty = new Set()
  const judge = (raw, where, ctx) => {
    refs += 1
    const lit = unquote(raw)
    if (!lit.includes('$') && isFirstPartyLookalike(lit)) add('first-party-lookalike', where, `${lit} names ${FIRST_PARTY.registry}/${FIRST_PARTY.namespace}/ in another spelling`)
    const { problem, resolved } = judgeRef(raw, ctx)
    if (problem) return add(problem.code, where, problem.message)
    if (resolved) {
      const repo = canonicalRepo(resolved)
      if (/(^|\/)minio(\/|$)/.test(repo)) add('object-storage-image', where, `${resolved}: an object-storage image (TRD-066/354)`)
      // gremion-deploy verifies a signature only on the exact first-party
      // prefix; a lookalike would reach the host third-party list and deploy
      // unsigned, so it is refused here, never listed.
      if (isFirstPartyLookalike(resolved)) add('first-party-lookalike', where, `${resolved} names ${FIRST_PARTY.registry}/${FIRST_PARTY.namespace}/ in another spelling`)
      else if (!isFirstParty(resolved)) thirdParty.add(repo)
    }
  }

  for (const f of files) {
    let text
    try {
      text = readFileSync(join(root, f), 'utf8')
    } catch (err) {
      add('unreadable', f, err.message)
      continue
    }
    const yaml = isYaml(f)
    if (yaml && YAML_BREAK_RE.test(text)) add('yaml-line-break', f, 'a line break other than LF/CRLF (lone CR, NEL, LS, PS): YAML reads lines this scan does not')
    const lines = codeLines(text, yaml)
    if (/\.tmpl$/.test(f)) checkComposeFile(f, text)
    const raw = !excluded.has(f)
    const env = envFor(f)
    for (const [i, l] of lines.entries()) {
      const where = `${f}:${l.no}`
      if (!l.line.trim()) continue
      // object-storage arm: every discovered file, exclusions or not.
      if (OS_ASSIGN_RE.test(l.line) || OS_EXPANSION_RE.test(l.line)) add('object-storage-key', where, `object-storage key: ${l.line.trim()}`)
      if (OS_PROFILE_RE.test(l.line)) add('object-storage-profile', where, `object-storage profile: ${l.line.trim()}`)
      if (yaml && OS_SERVICE_RE.test(l.line)) add('object-storage-service', where, `object-storage service: ${l.line.trim()}`)
      if (yaml && OS_YAML_KEY_RE.test(l.line)) add('object-storage-key', where, `object-storage key: ${l.line.trim()}`)
      if (OS_REF_RE.test(l.line)) add('object-storage-image', where, `object-storage image: ${l.line.trim()}`)
      if (!raw) continue
      // raw arm.
      if (LATEST_DEFAULT_RE.test(l.line)) add('latest', where, `a latest default: ${l.line.trim()} (latest fails everywhere)`)
      if (yaml && YAML_KEY_HAZARD_RE.test(l.line)) {
        add('non-canonical', where, `a YAML key this scan cannot read (explicit, alias or escaped): ${l.line.trim()}`)
        continue
      }
      if (yaml && /compose/.test(f) && (/^include\s*:/.test(l.line) || isExtendsFile(lines, i))) {
        add('compose-include', where, `compose loads another file (include/extends file:), outside the scan set: ${l.line.trim()}`)
        continue
      }
      if (yaml && IMAGE_KEY_RE.test(l.line)) {
        const m = CANONICAL_IMAGE_LINE_RE.exec(l.line)
        if (!m) {
          add('non-canonical', where, `unrecognised image declaration (only '<indent>image: <ref>' is verifiable): ${l.line.trim()}`)
          continue
        }
        judge(m[2], where, { env, build: siblingHasBuild(lines, i) })
        continue
      }
      if (yaml) {
        const y = YAML_IMAGE_ENV_RE.exec(l.line)
        if (y) {
          judge(y[2] ?? y[4], where, { env, build: false })
          continue
        }
      } else {
        const as = [...l.line.matchAll(IMAGE_ASSIGN_G)]
        for (const a of as) judge(a[2], where, { env: null, build: false })
        if (as.length) continue
      }
      const t = IMAGE_TAG_ASSIGN_RE.exec(l.line)
      if (t && unquote(t[2].replace(/\s+#.*$/, '')) === 'latest') {
        add('latest', where, `${t[1]}=latest (latest fails everywhere)`)
        continue
      }
      for (const m of l.line.matchAll(DEFAULT_RE)) {
        if (IMAGE_VAR_RE.test(m[1])) judge(m[0], where, { env: null, build: false })
      }
    }
  }

  // lockfile: a pilot-scoped proxy for "no tenant data depends on S3".
  try {
    const lock = readFileSync(join(root, LOCKFILE), 'utf8').split(/\r?\n/)
    for (const [i, l] of lock.entries()) {
      if (OS_LOCK_RE.test(l)) add('object-storage-lockfile', `${LOCKFILE}:${i + 1}`, `S3-compatible client in the lockfile: ${l.trim()}`)
    }
  } catch (err) {
    add('lockfile-unreadable', LOCKFILE, err.message)
  }

  return { files, refs, problems, thirdParty: [...thirdParty].sort() }
}

/** The third-party list for the host; throws on a RED tree (a partial list is worse than none). */
export function thirdPartyList(root) {
  const res = checkTree(root)
  if (res.problems.length) {
    throw new Error(`refusing to print a third-party list for a RED tree: ${res.problems.map((p) => `${p.code} ${p.where}`).join('; ')}`)
  }
  return res.thirdParty
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--root')
  const root = i >= 0 ? argv[i + 1] : fileURLToPath(new URL('../..', import.meta.url))
  if (!root || argv.some((a) => a.startsWith('--') && !['--root', '--third-party-list'].includes(a))) {
    console.error('usage: check-image-digests.mjs [--root DIR] [--third-party-list]')
    process.exit(2)
  }
  const res = checkTree(root)
  for (const p of res.problems) console.error(`check-image-digests: FAIL ${p.code}: ${p.where}: ${p.message}`)
  if (res.problems.length) {
    console.error(`check-image-digests: ${res.files.length} file(s), ${res.refs} image reference(s), ${res.problems.length} problem(s)`)
    process.exit(1)
  }
  if (argv.includes('--third-party-list')) {
    process.stdout.write(res.thirdParty.map((r) => `${r}\n`).join(''))
  } else {
    console.log(`check-image-digests: ${res.files.length} file(s), ${res.refs} image reference(s), 0 problem(s)`)
  }
}
