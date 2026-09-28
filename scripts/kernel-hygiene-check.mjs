#!/usr/bin/env node
// Kernel repo hygiene guard.
//
// Every assertion below is a POST-CONDITION on a file's content or on rendered
// output — never an exit code of the thing under test, and never "the command
// ran". Each check was watched RED before its fix landed.
//
// Deliberately Node and not BATS: on the maintainer's Windows box the npm
// `bats` wrapper costs ~84s per test file even for a no-op test, so a 20-test
// BATS hygiene suite would take half an hour and would simply stop being run.
// `gremion-ui/scripts/check-*.mjs` is the established fast-guard idiom here.
//
// Run:  node scripts/kernel-hygiene-check.mjs      (also wired into `make lint`)

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LOCAL_ENV_FILES, missingLocalEnvFiles, SETUP_FIRST } from './env/local-setup.mjs'
import { FIRST_PARTY_IMAGE, g9Check } from './lib/image-surfaces.mjs'

// GREMION_REPO_ROOT points the whole run at another tree; the g2 unit test in
// gremion-ui/tests/unit/check-app-port-binding.test.ts uses it on a temp copy.
const ROOT = process.env.GREMION_REPO_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..')
if (process.env.GREMION_REPO_ROOT) console.warn(`[kernel-hygiene] checking ${ROOT} (GREMION_REPO_ROOT override)`)
const failures = []
const checks = []

function check(id, fn) {
  checks.push(id)
  try {
    const problem = fn()
    if (problem) failures.push(`${id}: ${problem}`)
  } catch (err) {
    failures.push(`${id}: threw — ${err.message}`)
  }
}

const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const has = (p) => existsSync(join(ROOT, p))

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) walk(abs, out)
    else out.push(abs)
  }
  return out
}

// ── (a) BATS is an EXTERNAL prerequisite ───────────────────────────────────
// The three BATS submodules were declared in .gitmodules but never registered
// (0 gitlinks of mode 160000), so `git submodule update --init` was always a
// no-op and test/bats/bin/bats never existed. Every runner already fell back to
// `bats` on PATH. Registering them would vendor three deps that nothing loads
// (every .bats file loads only test_helper/common.bash). So: dropped.

check('a1 .gitmodules is gone', () =>
  has('.gitmodules') ? '.gitmodules still declares BATS submodules' : null)

check('a2 git tracks no gitlinks', () => {
  const out = execFileSync('git', ['ls-files', '-s'], { cwd: ROOT, encoding: 'utf8' })
  const links = out.split('\n').filter((l) => l.startsWith('160000'))
  return links.length ? `${links.length} gitlink(s) present: ${links.join(' | ')}` : null
})

check('a3 git submodule status is empty', () => {
  const out = execFileSync('git', ['submodule', 'status'], { cwd: ROOT, encoding: 'utf8' }).trim()
  return out ? `expected no submodules, got:\n${out}` : null
})

check('a4 install-bats.sh is gone', () =>
  has('test/install-bats.sh') ? 'test/install-bats.sh still present' : null)

// B0 CARVE-OUT, shared by (a5), (h1) and (i1) below.
//
// docs/superpowers/specs/ holds the two operator-approved design specs (spec B,
// spec D; 2026-09-15). They are committed BYTE-IDENTICAL to the approved
// originals under a `cmp` gate, so they cannot be edited to satisfy a guard —
// and they are the design record OF these very removals: spec B quotes the
// retired wire root and the retired staging host precisely because B1a/B1b are
// the units that delete them, and spec D explains why a module is cloned by
// manifest rather than by submodule. A historical description is not an
// instruction, which is what (a5)'s own comment already says.
//
// NARROW ON PURPOSE. The genuinely sensitive class — the six spec-A host
// literals — is NOT carved out here: check (k1) below scans `docs` with no
// exemption for this directory, and test/host/no-host-literals.bats scans the
// whole tracked tree. Both still see these two files.
const SPEC_DOCS_DIR = join(ROOT, 'docs', 'superpowers', 'specs')
const SPEC_DOCS_REL = /^docs[/]superpowers[/]specs[/]/

check('a5 no doc or build file tells the reader to init submodules for BATS', () => {
  const roots = ['docs', '.github', 'README.md', 'CONTRIBUTING.md', 'Makefile']
  // Match the INSTRUCTION, not the word. A doc may explain the history; what it
  // must not do is hand the reader a submodule command as the way to get BATS,
  // or have CI check submodules out for it.
  // Naming the retired script in a historical note is fine; handing the reader
  // a command to RUN it is the defect. Same for submodule commands.
  const re =
    /(bash|sh|\.\/)\s*\S*install-bats|git submodule (update|add|status)|--recurse-submodules|submodules:\s*recursive|test\/bats\/bin/i
  const offenders = []
  for (const r of roots) {
    const abs = join(ROOT, r)
    if (!existsSync(abs)) continue
    const files = statSync(abs).isDirectory() ? walk(abs) : [abs]
    for (const f of files) {
      if (f.startsWith(SPEC_DOCS_DIR)) continue // see the B0 carve-out above
      if (/\.(png|jpg|svg|ico|pdf)$/i.test(f)) continue
      if (re.test(readFileSync(f, 'utf8'))) offenders.push(relative(ROOT, f).replace(/\\/g, '/'))
    }
  }
  return offenders.length ? `stale submodule-onboarding prose in: ${offenders.join(', ')}` : null
})

check('a6 TESTING.md documents BATS as an external prerequisite with a real install command', () => {
  const t = read('docs/TESTING.md')
  return /npm install -g bats/.test(t) ? null : 'no `npm install -g bats` install line found'
})

check('a7 the Makefile invokes bats from PATH, not a vendored submodule path', () => {
  const m = read('Makefile')
  return m.includes('test/bats/bin/bats') ? 'Makefile still probes test/bats/bin/bats' : null
})

check('a8 CI installs bats rather than checking out submodules for it', () => {
  const ci = read('.github/workflows/ci.yml')
  return ci.includes('test/bats/bin/bats') ? 'ci.yml still probes test/bats/bin/bats' : null
})

check('a9 the documented onboarding path actually works — bats is runnable here', () => {
  try {
    // execSync, not execFileSync+shell:true — on Windows `bats` is a .cmd
    // shim that needs a shell, and passing args alongside shell:true is
    // deprecated (DEP0190). No interpolation here, so no injection surface.
    const v = execSync('bats --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return /Bats/i.test(v) ? null : `unexpected \`bats --version\` output: ${v.trim()}`
  } catch (err) {
    return `bats is not runnable from PATH (${err.message}) — the documented prerequisite is unmet`
  }
})

// ── (b) pnpm workspace globs ───────────────────────────────────────────────

check('b1 every pnpm-workspace.yaml package glob resolves to a real directory', () => {
  const ws = read('pnpm-workspace.yaml')
  // The `packages:` block runs from that key to the next column-0 key.
  const lines = ws.split('\n')
  const start = lines.findIndex((l) => /^packages:/.test(l))
  if (start === -1) return 'no `packages:` key found'
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^\S/.test(l))
  const block = (end === -1 ? rest : rest.slice(0, end)).join('\n')
  const globs = [...block.matchAll(/^\s*-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)].map((m) => m[1])
  if (globs.length === 0) return 'parsed zero globs — the check would vacuously pass'
  const unresolved = globs.filter((g) => {
    if (!g.includes('*')) return !existsSync(join(ROOT, g))
    const [parent] = g.split('/*')
    const abs = join(ROOT, parent)
    if (!existsSync(abs)) return true
    return readdirSync(abs).filter((n) => statSync(join(abs, n)).isDirectory()).length === 0
  })
  return unresolved.length ? `globs matching nothing: ${unresolved.join(', ')}` : null
})

// ── (c) stale TODO in tenant/resolve.ts ────────────────────────────────────

const RESOLVE = 'gremion-ui/src/lib/server/tenant/resolve.ts'

check('c1 the stale TODO(P2.1c) is gone from tenant/resolve.ts', () =>
  read(RESOLVE).includes('TODO(P2.1c)') ? 'TODO(P2.1c) still present' : null)

check('c2 the SECURITY INVARIANT block is still intact', () => {
  const f = read(RESOLVE)
  const required = [
    'SECURITY INVARIANT: tenant selection trusts ONLY the edge-injected',
    'attacker who sets x-forwarded-host selects ANY tenant',
    'The raw Host header is attacker-controllable and is',
  ]
  const missing = required.filter((s) => !f.includes(s))
  return missing.length ? `SECURITY INVARIANT text lost: ${missing.join(' // ')}` : null
})

check('c3 nothing back-references a TODO that no longer exists', () => {
  const f = read(RESOLVE)
  return /this file's `tenantResolveHandle` TODO/.test(f)
    ? 'dangling back-reference to the deleted TODO'
    : null
})

check('c4 the behaviour the TODO asked for is actually implemented', () => {
  const f = read(RESOLVE)
  const missing = ['export function isInternalTrustRequest', 'export const tenantForwardFetch'].filter(
    (s) => !f.includes(s)
  )
  return missing.length ? `TODO removed but its work is absent: ${missing.join(', ')}` : null
})

// ── (d) stale boundary-lint comment ────────────────────────────────────────

const BLINT = 'gremion-ui/scripts/boundary-lint.ts'

check('d1 the stale "enforcement lands in Task 12" comment is gone', () =>
  read(BLINT).includes('enforcement lands in Task 12') ? 'stale Task 12 comment still present' : null)

check('d2 the coverage enforcement that comment deferred is actually present', () => {
  const f = read(BLINT)
  const missing = ['problems.push(`missing in spec:', 'problems.push(`phantom in spec:'].filter(
    (s) => !f.includes(s)
  )
  return missing.length ? `coverage enforcement absent: ${missing.join(', ')}` : null
})

// ── (e) k8s ────────────────────────────────────────────────────────────────

function k8sImageLines() {
  return walk(join(ROOT, 'k8s'))
    .filter((f) => /\.ya?ml$/.test(f))
    .flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => ({ file: relative(ROOT, f).replace(/\\/g, '/'), line: i + 1, text: line }))
        .filter(({ text }) => /^\s*(-\s*)?image:\s*\S/.test(text))
    )
    .map((h) => ({
      ...h,
      // Strip the key, any trailing `# comment`, and quotes — a trailing comment
      // otherwise reads as part of the tag and every pinned image looks untagged.
      image: h.text
        .replace(/^\s*(-\s*)?image:\s*/, '')
        .replace(/\s+#.*$/, '')
        .replace(/["']/g, '')
        .trim(),
    }))
}

check('e1 no k8s manifest floats on a :latest tag', () => {
  const bad = k8sImageLines().filter((h) => /:latest$/.test(h.image))
  return bad.length ? bad.map((h) => `${h.file}:${h.line} ${h.image}`).join(' | ') : null
})

check('e2 every k8s image carries an explicit tag or digest', () => {
  const hits = k8sImageLines()
  if (hits.length === 0) return 'found zero image: lines — the check would vacuously pass'
  const bad = hits.filter((h) => {
    if (h.image.includes('@sha256:')) return false
    const last = h.image.split('/').pop()
    return !last.includes(':')
  })
  return bad.length
    ? `untagged (implicit :latest): ${bad.map((h) => `${h.file}:${h.line} ${h.image}`).join(' | ')}`
    : null
})

check('e3 kubectl kustomize k8s/base renders with NO --load-restrictor flag', () => {
  let out
  try {
    out = execFileSync('kubectl', ['kustomize', 'k8s/base'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    return `bare build failed: ${(err.stderr || err.message).toString().trim()}`
  }
  const kinds = out.split('\n').filter((l) => l.startsWith('kind:')).length
  return kinds > 0 ? null : 'build produced zero `kind:` documents'
})

check('e4 the bare kustomize build emits nothing on stderr (no errors, no deprecations)', () => {
  let stderr = ''
  try {
    execFileSync('kubectl', ['kustomize', 'k8s/base'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    stderr = (err.stderr || err.message).toString()
  }
  // re-run capturing stderr on the success path too
  if (!stderr) {
    const res = execFileSync(
      process.platform === 'win32' ? 'cmd' : 'sh',
      process.platform === 'win32'
        ? ['/c', 'kubectl kustomize k8s/base 2>&1 1>NUL']
        : ['-c', 'kubectl kustomize k8s/base 2>&1 1>/dev/null'],
      { cwd: ROOT, encoding: 'utf8' }
    )
    stderr = res
  }
  return stderr.trim() ? `stderr not empty:\n${stderr.trim()}` : null
})

check('e5 the shared docker/ config files are still single-copy (nothing forked into k8s/)', () => {
  // B-01 (spec B T.4): the boot import is gone. The one shared Keycloak file
  // left is the per-tenant TEMPLATE, whose only consumer is buildTenantRealmDoc.
  if (!has('docker/keycloak/realm-export.base.json')) {
    return 'docker/keycloak/realm-export.base.json missing'
  }
  const forked = walk(join(ROOT, 'k8s')).filter((f) =>
    /(realm-export(\.base)?\.json|substitute-realm-secrets\.sh)$/.test(f)
  )
  return forked.length
    ? `shared config forked into k8s/: ${forked.map((f) => relative(ROOT, f)).join(', ')}`
    : null
})

// ── (g) image placeholders: a sentinel nobody patches is WORSE than :latest ─
//
// e1/e2 catch a FLOATING tag (`:latest`, or no tag at all). They say nothing
// about a tag that is pinned but IMAGINARY. Replacing `:latest` with a literal
// `OVERLAY_MUST_PROVIDE_DIGEST_PINNED_TAG` passed e1 and e2 cleanly while making
// every overlay render an image that cannot be pulled — a soft problem (mutable
// tag) traded for a hard one (nothing deploys).
//
// It also does NOT "fail fast on kubectl apply", as the comment that shipped
// with it claimed. `container.image` is an unconstrained string in the PodSpec
// schema, and the OCI tag grammar is `[A-Za-z0-9_][A-Za-z0-9._-]{0,127}` — which
// that sentinel satisfies. So the API server admits the object and the pod sits
// in ImagePullBackOff. The failure is LATE and silent, not fast.
//
// Fail-fast therefore has to live HERE, at lint time, where it can actually be
// enforced — which is the whole point: do not assert in a comment a property
// that nothing checks.

// A tag that ANNOUNCES it must be replaced. Two shapes:
//   - a known placeholder vocabulary, and
//   - the generic "SCREAMING_SNAKE sentinel" form, so a NOVEL sentinel string
//     nobody thought to add to the vocabulary is still caught.
const PLACEHOLDER_WORDS =
  /(MUST_|_MUST_|PROVIDE|PLACEHOLDER|CHANGE_?ME|YOUR_?ORG|YOUR_?REGISTRY|REPLACE_?ME|TBD|TODO|FIXME|XXXX)/i

function placeholderReason(image) {
  // Split off the tag: everything after the last ':' that is not part of a
  // registry host:port (a host:port is followed by a '/').
  const digest = image.includes('@sha256:')
  const ref = digest ? image.slice(0, image.indexOf('@')) : image
  const lastColon = ref.lastIndexOf(':')
  const tag = lastColon > ref.lastIndexOf('/') ? ref.slice(lastColon + 1) : ''
  const name = lastColon > ref.lastIndexOf('/') ? ref.slice(0, lastColon) : ref
  if (PLACEHOLDER_WORDS.test(tag)) return `tag "${tag}" is a placeholder`
  if (PLACEHOLDER_WORDS.test(name)) return `repository "${name}" is a placeholder`
  // Generic sentinel shape: SCREAMING_SNAKE, no lowercase, has an underscore.
  if (/^[A-Z0-9]+(_[A-Z0-9]+)+$/.test(tag)) return `tag "${tag}" is a SCREAMING_SNAKE sentinel`
  return null
}

const OVERLAY_ROOT = join(ROOT, 'k8s', 'overlays')
const overlayNames = existsSync(OVERLAY_ROOT)
  ? readdirSync(OVERLAY_ROOT).filter((n) => statSync(join(OVERLAY_ROOT, n)).isDirectory())
  : []

// Render an overlay the way the docs tell an operator to. Bare first; the dev
// overlay is the one documented exception (it secretGenerates from the repo-root
// `.env`, a FILE load above its own root) and needs LoadRestrictionsNone.
// The ONE overlay k8s/base/kustomization.yaml documents as needing the flag.
// Anything else needing it is a regression, so it is named here rather than
// discovered — see g8.
const FLAG_EXEMPT_OVERLAYS = new Set(['dev'])

const renderCache = new Map()
function renderOverlay(name) {
  if (renderCache.has(name)) return renderCache.get(name)
  // spawnSync, not execFileSync: stderr must be readable on the SUCCESS path
  // too. kustomize prints deprecation warnings to stderr while exiting 0, so an
  // exception-only reading of stderr cannot see them — which is precisely how
  // four overlays kept emitting `bases`/`commonLabels` warnings under a comment
  // claiming "EMPTY stderr, no warnings".
  const attempt = (args) => {
    const r = spawnSync('kubectl', args, { cwd: ROOT, encoding: 'utf8' })
    if (r.error) return { err: r.error.message }
    if (r.status !== 0) return { err: (r.stderr || `exit ${r.status}`).toString().trim() }
    return { out: r.stdout, stderr: (r.stderr || '').toString() }
  }
  const rel = `k8s/overlays/${name}`
  let neededFlag = false
  let r = attempt(['kustomize', rel])
  if (r.err) {
    neededFlag = true
    r = attempt(['kustomize', '--load-restrictor', 'LoadRestrictionsNone', rel])
  }
  const result = r.err
    ? { name, error: r.err, images: [], neededFlag, stderr: '' }
    : {
        name,
        error: null,
        neededFlag,
        stderr: r.stderr,
        images: r.out
          .split('\n')
          .filter((l) => /^\s*(-\s*)?image:\s*\S/.test(l))
          .map((l) => l.replace(/^\s*(-\s*)?image:\s*/, '').replace(/\s+#.*$/, '').replace(/["']/g, '').trim()),
      }
  renderCache.set(name, result)
  return result
}

check('g1 the overlay set is enumerated, not assumed', () => {
  if (overlayNames.length === 0) return 'k8s/overlays enumerated zero overlays — every g-check would vacuously pass'
  return null
})

// kustomize prints deprecation WARNINGS to stderr ahead of the real `error:`
// line. Reporting stderr's first line therefore reports the warning and hides
// the cause — it cost a debugging cycle. Prefer the `error:` line.
function stderrCause(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.find((l) => /^error:/i.test(l)) || lines[lines.length - 1] || text.trim()
}

// A render can fail for two very different reasons, and conflating them cost a
// debugging cycle: the overlay is broken, or the working copy simply has not
// been set up (the dev overlay's secretGenerator reads the git-ignored .env and
// legal/legal.env). Only the first is a defect in the repo. Say which one this is.
//
// TASK-028 (D1): the answer comes from the file system, BEFORE the render
// (scripts/env/local-setup.mjs). LOCAL_ENV_OVERLAYS names the overlays whose
// generators read those files; any other overlay is always rendered. The
// stderr match below is only the second net.
const LOCAL_ENV_OVERLAYS = new Set(['dev'])
// A stat error other than ENOENT (EACCES, ENOTDIR) is not "absent"; it is
// reported by g2 itself instead of killing every other check at import.
let MISSING_LOCAL_ENV = []
let LOCAL_ENV_ERROR = null
try {
  MISSING_LOCAL_ENV = missingLocalEnvFiles(ROOT)
} catch (err) {
  LOCAL_ENV_ERROR = err
}

// Only a LOCAL_ENV_FILES path counts: an overlay naming any other missing file
// is broken, and "run setup first" would not fix it.
function missingLocalEnvFile(text, overlay) {
  const m = /env source files: \[([^\]]+)\]/.exec(text)
  if (!m || !/no such file|cannot find the file/i.test(text)) return null
  const rel = relative(ROOT, resolve(OVERLAY_ROOT, overlay, m[1].trim())).replace(/\\/g, '/')
  return LOCAL_ENV_FILES.includes(rel) ? rel : null
}

const notSetUp = (name, missing) =>
  `${name}: NOT CHECKED — this working copy has no ${missing}; ${SETUP_FIRST}. The overlay itself was not evaluated.`

check('g2 every overlay renders, and renders a non-zero number of image: lines', () => {
  const problems = []
  if (LOCAL_ENV_ERROR) problems.push(`local env files could not be checked: ${LOCAL_ENV_ERROR.message}`)
  for (const name of overlayNames) {
    if (LOCAL_ENV_OVERLAYS.has(name) && MISSING_LOCAL_ENV.length > 0) {
      problems.push(notSetUp(name, MISSING_LOCAL_ENV.join(', ')))
      continue
    }
    const r = renderOverlay(name)
    if (!r.error && r.images.length > 0) continue
    if (!r.error) {
      problems.push(`${r.name}: rendered zero image: lines`)
      continue
    }
    const missing = missingLocalEnvFile(r.error, r.name)
    problems.push(missing ? notSetUp(r.name, missing) : `${r.name}: render FAILED — ${stderrCause(r.error)}`)
  }
  return problems.length ? problems.join(' | ') : null
})

check('g3 no BASE image is a placeholder that the overlays fail to patch', () => {
  // A sentinel is only legitimate if EVERY overlay actually replaces it. If even
  // one overlay renders it through, base is shipping an unpullable reference.
  const baseSentinels = k8sImageLines()
    .filter((h) => h.file.startsWith('k8s/base/'))
    .map((h) => ({ ...h, why: placeholderReason(h.image) }))
    .filter((h) => h.why)
  if (!baseSentinels.length) return null
  const problems = []
  for (const s of baseSentinels) {
    const unpatched = overlayNames.filter((n) => renderOverlay(n).images.includes(s.image))
    problems.push(
      unpatched.length
        ? `${s.file}:${s.line} ${s.image} (${s.why}) survives unpatched into ${unpatched.length}/${overlayNames.length} overlays: ${unpatched.join(', ')}`
        : null
    )
  }
  const real = problems.filter(Boolean)
  return real.length ? real.join(' | ') : null
})

check('g4 no overlay RENDERS a placeholder image (the applyable-output post-condition)', () => {
  const problems = []
  for (const name of overlayNames) {
    const r = renderOverlay(name)
    if (r.error) continue // already reported by g2
    for (const img of [...new Set(r.images)]) {
      const why = placeholderReason(img)
      if (why) problems.push(`${name}: ${img} — ${why}`)
    }
  }
  return problems.length ? problems.join(' | ') : null
})

// FIRST_PARTY_IMAGE (scripts/lib/image-surfaces.mjs) decides whether g5 has
// anything to check at all; keep it and the manifests in step.
check('g5 base pins every first-party gremion image to the kernel version', () => {
  const version = JSON.parse(read('package.json')).version
  if (!version) return 'package.json declares no version'
  const firstParty = k8sImageLines().filter(
    (h) => h.file.startsWith('k8s/base/') && FIRST_PARTY_IMAGE.test(h.image)
  )
  if (!firstParty.length)
    return 'found zero first-party ghcr.io/hello-n00del/gremion-* images in k8s/base — the check would vacuously pass'
  const bad = firstParty.filter((h) => !h.image.endsWith(`:${version}`) && !h.image.includes('@sha256:'))
  return bad.length
    ? `expected :${version} (or a digest): ${bad.map((h) => `${h.file}:${h.line} ${h.image}`).join(' | ')}`
    : null
})

// g9 (why it exists next to g5, its surfaces, its scan) lives in
// scripts/lib/image-surfaces.mjs so its test runs it on a fixture tree.
check('g9 no shipped manifest or deploy doc names a gremion image outside ghcr.io/hello-n00del', () =>
  g9Check(ROOT))

// A comment claiming that a SENTINEL makes `kubectl apply` fail fast. Both word
// orders, because the first version of this check only matched "fails fast on
// kubectl apply" and sailed straight past the ingressroutes-prod header, which
// says "`kubectl apply` against the rendered overlay FAILS FAST" — the same
// false claim with the clauses swapped.
//
// `[^.\n]` deliberately keeps each alternative inside ONE sentence on ONE line,
// so an unrelated runtime claim elsewhere in the file cannot be stitched onto a
// stray "kubectl apply". k8s/base/gremion-public/secret.yaml is the live example:
// it says the sentinel "fails fast at runtime", which is TRUE (an unparseable DB
// URL does fail on connect) and must not be flagged.
const APPLY_FAIL_FAST_CLAIM =
  /fails?\s+fast[^.\n]{0,120}kubectl\s+apply|kubectl\s+apply[^.\n]{0,120}fails?\s+fast|MUST provide a digest[^.\n]{0,200}fails?\s+fast/i

check('g6 no k8s manifest asserts the unenforceable "sentinel fails fast on kubectl apply" claim', () => {
  // `image:` is an unconstrained string, and so is an IngressRoute `match`.
  // Nothing rejects a well-formed but imaginary value at apply time — the API
  // server admits the object and the failure surfaces later (ImagePullBackOff,
  // or a route that simply matches no traffic). A comment that promises
  // otherwise is a false safety claim, and false safety claims are how this
  // defect shipped. Enforcement belongs at lint time, i.e. here.
  const offenders = walk(join(ROOT, 'k8s'))
    .filter((f) => /\.ya?ml$/.test(f))
    .filter((f) => APPLY_FAIL_FAST_CLAIM.test(readFileSync(f, 'utf8')))
    .map((f) => relative(ROOT, f).replace(/\\/g, '/'))
  return offenders.length ? `unenforceable fail-fast claim in: ${offenders.join(', ')}` : null
})

check('g8 only the documented overlay needs --load-restrictor, and the rest render with EMPTY stderr', () => {
  // k8s/base/kustomization.yaml's HOW TO BUILD block promises `kubectl kustomize
  // k8s/overlays/<env>` with "No flags ... EMPTY stderr, no warnings", naming
  // dev as the ONE exception. Nothing enforced that: g2 only asked whether an
  // overlay rendered AT ALL, and renderOverlay silently retries with the flag,
  // so an overlay that newly needed it still looked green.
  const problems = []
  for (const name of overlayNames) {
    const r = renderOverlay(name)
    if (r.error) continue // g2 reports a hard render failure
    const exempt = FLAG_EXEMPT_OVERLAYS.has(name)
    if (r.neededFlag && !exempt) {
      problems.push(`${name}: needs --load-restrictor but base documents only ${[...FLAG_EXEMPT_OVERLAYS].join(', ')} as exempt`)
    }
    if (!r.neededFlag && exempt) {
      problems.push(`${name}: documented as needing --load-restrictor but renders bare — the base comment is now stale`)
    }
    if (r.stderr.trim()) {
      problems.push(`${name}: stderr not empty — ${r.stderr.trim().split('\n')[0]}`)
    }
  }
  return problems.length ? problems.join(' | ') : null
})

check('g7 base\'s "every overlay carries an images: example" promise is actually true', () => {
  // Same defect class as the sentinel itself: a comment asserting a property
  // nothing enforces. k8s/base/kustomization.yaml points the operator at "a
  // kustomize `images:` block in your overlay. Every overlay in k8s/overlays/
  // carries a commented, copy-pasteable example." When that sentence was
  // written, ZERO of the five overlays carried one.
  //
  // The check is conditional on the promise so the two can never drift: delete
  // the sentence from base and this goes quiet; keep it and every overlay must
  // honour it.
  const promised = /every overlay[\s\S]{0,120}carries a commented, copy-pasteable example/i.test(
    read('k8s/base/kustomization.yaml')
  )
  if (!promised) return null
  if (!overlayNames.length) return 'zero overlays enumerated — the check would vacuously pass'
  const missing = overlayNames.filter((n) => {
    const p = join(OVERLAY_ROOT, n, 'kustomization.yaml')
    if (!existsSync(p)) return true
    const t = readFileSync(p, 'utf8')
    // A commented (so it cannot alter the render), copy-pasteable kustomize
    // override: the `images:` key, a first-party target, and a replacement
    // coordinate. All three, or it is not copy-pasteable.
    return !(
      /^\s*#\s*images:/m.test(t) &&
      /^\s*#\s*-?\s*name:\s*ghcr\.io\/hello-n00del\/gremion-/m.test(t) &&
      /^\s*#\s*newName:/m.test(t)
    )
  })
  return missing.length
    ? `k8s/base/kustomization.yaml promises every overlay carries a commented images: example; absent in: ${missing.join(', ')}`
    : null
})

// ── (f) .github hygiene ────────────────────────────────────────────────────

const PRT = '.github/PULL_REQUEST_TEMPLATE.md'

check('f1 the PR template carries no instance / retired-subsystem vocabulary', () => {
  const t = read(PRT)
  const banned = ['StuFis', 'StuRaOS', 'Phase 2', 'Phase 3', 'Phase 1']
  const hits = banned.filter((b) => t.includes(b))
  return hits.length ? `PR template still says: ${hits.join(', ')}` : null
})

check('f2 the PR template speaks kernel vocabulary and names commands that exist', () => {
  const t = read(PRT)
  const required = ['make lint', 'make test', 'boundary-lint', 'gremion']
  const missing = required.filter((s) => !t.includes(s))
  return missing.length ? `PR template missing: ${missing.join(', ')}` : null
})

check('f3 SECURITY.md exists', () => (has('SECURITY.md') ? null : 'SECURITY.md missing'))

// f4 was, until the disclosure decision was taken, the inverse of this check: it
// REQUIRED a PLACEHOLDER marker and forbade any address, so that nobody could
// publish a contact nobody monitors. The decision has now been taken
// (security@gremion.de plus GitHub private vulnerability reporting), so the old
// assertion would hold the file to a state the project deliberately left. The
// intent is unchanged and still enforced: exactly one address, and it is the
// decided one. A researcher-facing file that names no channel, or names some
// other address somebody invented, still fails.
const DISCLOSURE_ADDRESS = 'security@gremion.de'
check('f4 SECURITY.md names the decided disclosure channel and no other', () => {
  if (!has('SECURITY.md')) return 'SECURITY.md missing'
  const s = read('SECURITY.md')
  if (s.includes('PLACEHOLDER')) return 'the operator PLACEHOLDER block is still in the file'
  if (!s.includes(DISCLOSURE_ADDRESS)) return `does not name ${DISCLOSURE_ADDRESS}`
  if (!/security\/advisories\/new/.test(s)) {
    return 'does not point at GitHub private vulnerability reporting'
  }
  const emails = [...new Set(s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [])]
  const invented = emails.filter((e) => e !== DISCLOSURE_ADDRESS)
  return invented.length ? `an address was invented: ${invented.join(', ')}` : null
})

check('f5 CODE_OF_CONDUCT.md exists', () =>
  has('CODE_OF_CONDUCT.md') ? null : 'CODE_OF_CONDUCT.md missing')

// Every workflow file, for the label-reference leg of f6 below.
function workflowFiles() {
  const dir = join(ROOT, '.github', 'workflows')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))
    .map((n) => `.github/workflows/${n}`)
}

check('f6 every label .github/ references is declared in .github/labels.yml', () => {
  if (!has('.github/labels.yml')) return '.github/labels.yml roster missing'
  const roster = read('.github/labels.yml')
  const declared = new Set(
    [...roster.matchAll(/^\s*-\s*name:\s*["']?([^"'\n]+?)["']?\s*$/gm)].map((m) => m[1])
  )
  if (declared.size === 0) return 'roster declares zero labels — the check would vacuously pass'

  // Leg 1 — dependabot.yml's inline `labels: [a, b]` form.
  const fromDependabot = [
    ...read('.github/dependabot.yml').matchAll(/^\s*labels:\s*\[([^\]]*)\]\s*$/gm),
  ].flatMap((m) => m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')))
  if (fromDependabot.length === 0)
    return 'parsed zero dependabot labels — the check would vacuously pass'

  // Leg 2 — `gh pr create --label <name>` inside a workflow. This leg did not
  // exist, and the gap had teeth: dependabot-billing-monitor.yml passed
  // `--label automated`, a label in neither the roster nor the repository, so
  // `gh pr create` would have failed AFTER `git push` had already created the
  // branch — leaving orphan ci/* branches behind in what is about to be a
  // public repo. `make labels` creates only what labels.yml declares, so
  // nothing could have healed it either. The old check read dependabot.yml and
  // nothing else, so it was structurally blind to it.
  const workflows = workflowFiles()
  if (workflows.length === 0) return 'found zero workflow files — the check would vacuously pass'
  const fromWorkflows = []
  for (const f of workflows) {
    const re = /--label[= ]+(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9][A-Za-z0-9_.:-]*))/g
    for (const m of read(f).matchAll(re)) fromWorkflows.push(m[1] ?? m[2] ?? m[3])
  }

  const referenced = [...new Set([...fromDependabot, ...fromWorkflows])]
  const missing = referenced.filter((l) => !declared.has(l))
  return missing.length
    ? `referenced but not declared in .github/labels.yml: ${missing.join(', ')}`
    : null
})

// ── (h) the retired wire root ──────────────────────────────────────────────
//
// The NATS subject root is the product token no longer. The two per-leaf
// contract tests (calendar-contract.test.ts, content-contract.test.ts) each tie
// their OWN AsyncAPI address to their OWN subject builder, so neither can see a
// literal that lives anywhere else. Two surfaces had no cover at all:
//
//   - packages/ports/src/nats-broker.ts's default `subjects` parameter — a
//     hardcoded default NOT sourced from STREAMS, so renaming STREAMS alone
//     leaves every caller that omits the argument on the old filter; and
//   - contracts/kernel/asyncapi.provisioning.json — no contract-tie test exists
//     for it at all.
//
// A stale literal in either is silent: the publisher publishes and the consumer
// subscribes, on subjects nothing else reads. So the guard sweeps rather than
// naming files — a NEW leaf contract that copy-pastes the old root is caught the
// day it lands, not the day its stream is found empty.
//
// Scope: every git-TRACKED file in the REPO. `git ls-files`, not walk(), so
// node_modules and build output can neither make this vacuous nor make it slow.
//
// The scope is the whole tree and not `packages/ + contracts/` because those two
// directories DEFINE the wire but do not CONSUME it. The consumers are what break
// silently, and they live elsewhere: gremion-ui/src/lib/server/ports/ports-shim.
// test.ts pinned the retired root and went RED the moment broker.ts renamed, and
// gremion-ui/src/lib/server/boundary/contracts-schema.test.ts carries a wire
// literal in its AsyncAPI fixture. A guard scoped to the producer cannot see
// either, so it reports a clean rename over a broken tree.
//
// CARVE-OUT - a HOST is not a subject. The negative lookahead exempts the
// `sturaos.com` shape and ONLY that one: `sturaos.newsletter...`, `sturaos.*....`
// and `sturaos.{tenantId}....` are all still subjects and all still fail. The
// exemption is NOT a blessing - that host was the operator's staging deployment,
// it is stopped for good, and (i) below forbids it outright in every shipped
// deploy, contract, CI and doc surface. Keeping the two checks separate is
// deliberate: (h) owns the wire, (i) owns the host, and neither has to weaken
// its own pattern to accommodate the other.
//
// The left anchor `[^A-Za-z0-9._-]` says the root must START a subject, so an
// identifier that merely CONTAINS the token (`de.sturaos.app:/…`, a mobile
// scheme) is not a wire literal and is not flagged.
const RETIRED_WIRE_ROOT = /(^|[^A-Za-z0-9._-])sturaos\.(?!com\b)[A-Za-z0-9_{*>%$-]/i

// PATH CARVE-OUT — one, and it is the only place where `sturaos.` is provably
// not a subject:
//
//  - scripts/kernel-hygiene-check.mjs — this file. It must be able to quote the
//    pattern it forbids; without the carve-out the guard can never pass, which
//    is the one failure mode that gets a guard deleted.
const WIRE_ROOT_EXEMPT_PATHS = [
  /^scripts\/kernel-hygiene-check\.mjs$/,
  SPEC_DOCS_REL, // B0: the approved design specs — see the carve-out note at (a5)
]

check('h1 no retired wire-root literal survives anywhere in the tree', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (files.length === 0) return 'git ls-files matched zero files — the check would vacuously pass'
  const offenders = []
  for (const rel of files) {
    if (/\.(png|jpe?g|gif|svg|ico|pdf|woff2?)$/i.test(rel)) continue
    if (WIRE_ROOT_EXEMPT_PATHS.some((re) => re.test(rel))) continue
    const abs = join(ROOT, rel)
    if (!existsSync(abs)) continue // tracked but deleted in the working tree
    readFileSync(abs, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (RETIRED_WIRE_ROOT.test(line)) offenders.push(`${rel}:${i + 1} ${line.trim().slice(0, 100)}`)
      })
  }
  return offenders.length
    ? `retired wire root still on the wire in ${offenders.length} place(s): ${offenders.join(' | ')}`
    : null
})

// ── (h2) the retired product token as a BARE identifier ────────────────────
//
// (h1) above requires a trailing dot, because it owns the NATS subject root.
// That trailing dot is exactly how the login theme survived the public flip:
// `themes/sturaos/`, `loginTheme: "sturaos"` and a realm path segment named
// after the retired product were the token
// standing alone, and h1 walked past every one of them while reporting clean.
// This rule is the token as an IDENTIFIER, with no dot required.
//
// CASE-SENSITIVE, lower-case only, and deliberately so. `StuRaOS` is the name
// of a vertical (D-02) and of the issues this repo cites; it is a proper noun in
// prose with its own zero-tolerance owner at gremion-ui/src/lib/brand.guard
// .test.ts:70-71 (the FORBIDDEN entry `product "StuRaOS"`, empty allow-list).
// What this rule owns is the lower-case identifier: a directory name, a realm
// segment, a message-key prefix, a stylesheet filename.
// BOUNDARIES: lookaround on LETTERS AND DIGITS ONLY. The first draft of this
// rule put `-` and `_` inside the boundary classes, which meant a hyphen or an
// underscore immediately after the token defeated the match: `sturaos-realm
// .json`, `sturaos-users-0.json`, `sturaos_realm` and `themes/sturaos-v2/` all
// read as clean. That is the same species of hole as h1's trailing dot — the
// hole this whole check exists to close — and it was live: the five carriers in
// the Keycloak realm-secret substitution script (deleted by B-01 together with
// the whole boot-import path) and the two installed-hook markers in
// install-git-hooks.mjs were invisible to it. A separator is a boundary, not
// part of the identifier.
const RETIRED_PRODUCT_TOKEN = /(?<![A-Za-z0-9])sturaos(?![A-Za-z0-9])/
// ALLOW-LIST - four kinds of entry, each with its reason, and it does not grow
// without one:
//  - this file, which must be able to spell what it forbids;
//  - gremion-ui/src/lib/server/tenant/provisioner/realm-identity.test.ts,
//    which is the B-01 companion guard: it runs `git grep` over the tracked
//    tree and asserts the retired realm path segment occurs in no non-doc,
//    non-vitest file. It carries the token for the same reason this file
//    does - a guard has to name what it forbids - and for no other: the file
//    is ~100 lines long and exists only for that post-condition, so the
//    exemption hides nothing a reader would not expect to find there;
//  - gremion-ui/scripts/install-git-hooks.mjs, whose MARKER_BEGIN/MARKER_END
//    (:29-30) delimit the block ALREADY WRITTEN into every developer's
//    .git/hooks/pre-commit. Changing the marker orphans every installed block:
//    the installer would no longer find its own managed region, and would
//    append a second one beside it. This entry is LIVE, not decorative: the
//    markers are `# >>> sturaos-boundary-lint >>>`, hyphenated, so they are hit
//    by the boundary rule above and would fail the check without it;
//  - the four SHA-pinned APPLIED migrations. Their bytes are pinned in
//    baseline-hashes.json (B7) and 008 is B6's single named byte-equality
//    exception; editing one is a schema-integrity failure, not a rename. All
//    four are listed on BYTE-IMMUTABILITY grounds, not on a current hit:
//    measured at f7ac826 only 043:50 carries the token at all, and as the
//    capital `StuRaOS` in a comment, which this case-sensitive rule would not
//    match anyway; 008, 042 and 048 carry no `stura` token whatsoever.
const PRODUCT_TOKEN_EXEMPT_PATHS = [
  /^scripts\/kernel-hygiene-check\.mjs$/,
  /^gremion-ui\/src\/lib\/server\/tenant\/provisioner\/realm-identity\.test\.ts$/,
  /^gremion-ui\/scripts\/install-git-hooks\.mjs$/,
  /^gremion-ui\/migrations\/008_public_portal\.sql$/,
  /^gremion-ui\/migrations\/042_protocol_resolution_required_majority\.sql$/,
  /^gremion-ui\/migrations\/043_audit_log_hash_chain\.sql$/,
  /^gremion-ui\/migrations\/048_resolution_decided_at\.sql$/,
]

// PENDING - a dated, per-line waiver, and NOT a second allow-list. The
// difference matters: an allow-list entry is a path this rule stops looking at,
// a PENDING entry is one exact line, in one file, at one count, that the rule
// has seen and is holding. It is enforced in BOTH directions:
//   - a carrier that is NOT pending fails, so a NEW occurrence still breaks the
//     build the day it is written;
//   - a pending line that no longer occurs, or occurs a different number of
//     times, ALSO fails, so the waiver cannot outlive its cause. When the realm
//     unit lands, these entries stop matching and h2 goes red until they are
//     deleted. A waiver nobody is forced to remove is a waiver that rots.
// Entries carry no line numbers on purpose: a line number drifts under every
// edit above it, the exact text does not.
//
// The list opened on 2026-09-16 with 29 entries under ONE cause: the realm a
// running Keycloak served was still named with the retired token, and renaming
// it was a deployment-identity migration owned by
// B1a-realm-identity-and-boot-import. B1a has landed - it deleted the boot
// import, the generated realm export and the realm-secret substitution script,
// and renamed the realm path segment in every remaining carrier - so the cause
// is closed and every entry is gone. The list stays here, empty, because that
// is what an EMPTY ledger looks like: a new carrier now fails h2 on the day it
// is written, and adding an entry back requires writing its cause down first.
const PRODUCT_TOKEN_PENDING = [
]

check('h2 the retired product token survives nowhere as a bare identifier', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean)
  if (files.length === 0) return 'git ls-files matched zero files - the check would vacuously pass'
  // rel -> (exact trimmed line -> { count, lines })
  const carriers = new Map()
  for (const rel of files) {
    if (/\.(png|jpe?g|gif|svg|ico|pdf|woff2?)$/i.test(rel)) continue
    if (PRODUCT_TOKEN_EXEMPT_PATHS.some((re) => re.test(rel))) continue
    // The specs quote the rename they order. NOW LIVE: B0-spec-docs-and-waiver-
    // ledger tracks exactly two files here, spec-b-*.md and spec-d-*.md, both
    // committed byte-identical to the operator-approved originals, so the token
    // they quote cannot be edited out of them. Nothing else under the directory
    // is tracked (.gitignore:188-196 re-includes only those two globs, and
    // test/host/spec-docs.bats fails if a third path appears), so this carve-out
    // covers the two frozen records and nothing more.
    if (rel.startsWith('docs/superpowers/specs/')) continue
    const abs = join(ROOT, rel)
    if (!existsSync(abs)) continue
    readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
      if (!RETIRED_PRODUCT_TOKEN.test(line)) return
      const text = line.trim()
      if (!carriers.has(rel)) carriers.set(rel, new Map())
      const inFile = carriers.get(rel)
      const seen = inFile.get(text) || { count: 0, lines: [] }
      seen.count += 1
      seen.lines.push(i + 1)
      inFile.set(text, seen)
    })
  }
  const problems = []
  // LEG 1 - a pending entry that no longer matches. Deleted file, edited line or
  // a different number of occurrences: every one of them means the waiver is
  // stale and has to go, and none of them may pass silently.
  const held = new Map()
  for (const [rel, text, count] of PRODUCT_TOKEN_PENDING) {
    const found = carriers.get(rel)?.get(text)?.count || 0
    if (found !== count) {
      problems.push(`STALE WAIVER ${rel} :: ${text.slice(0, 80)} - waived ${count}, found ${found}; delete the entry`)
    }
    held.set(rel + '\u0000' + text, count)
  }
  // LEG 2 - a carrier nobody waived, or more of one than was waived.
  for (const [rel, inFile] of carriers) {
    for (const [text, seen] of inFile) {
      const waived = held.get(rel + '\u0000' + text) || 0
      if (seen.count > waived) {
        for (const ln of seen.lines.slice(waived)) problems.push(`${rel}:${ln} ${text.slice(0, 100)}`)
      }
    }
  }
  return problems.length
    ? `the retired product token is still a live identifier in ${problems.length} unwaived place(s): ${problems.join(' | ')}`
    : null
})

// -- (i) the operator's retired host in shipped deploy + contract surfaces ----
//
// (h) above is about the NATS SUBJECT root. This one is about a HOST, and the
// two are different failure modes: a stale subject is silent on the wire, a
// stale host is a third party's domain baked into what we ship.
//
// `sturaos.com` was the operator's staging deployment. It is stopped for good
// and the kernel is public, so any occurrence in a shipped artefact is either a
// dead reference or an instruction to trust a host the deployer does not own.
// It had reached the realm template's redirect URIs and web origins, the
// published OpenAPI `servers` block, CI env, the Traefik/k8s ingress templates
// and the ACME/DNS instructions -- none of which any guard looked at.
//
// SCOPE -- the WHOLE tracked tree. It used to stop at the surfaces a deployer or
// an API client consumes, because the app source and ~25 of its test fixtures
// still used the retired host as their example apex and a tree-wide rule would
// have been red on day one. That app-source sweep has landed (the issuer and
// Matrix defaults are gone from register-default.ts, the seed blueprint's
// e-mail domain is @council.example, and the fixtures use RFC 2606 names), so
// the exclusion has no remaining subject and the guard now sees everything.
// A prefix list that no longer names an exception is worse than no list: it
// reads as coverage while quietly excluding whatever is not on it.
// Two hosts, one rule. `sturaos.com` was the operator's staging deployment.
// `stura.org` is a real, registrable domain this project does not own and never
// did - it survived in the k8s installer as the ACME account address and the
// DNS instruction, i.e. as a live instruction to a reader. Neither belongs in
// anything a deployer or an API client consumes. RFC 2606 names do.
//
// The `\\*` before the dot is LOAD-BEARING, not decoration. The single place
// these hosts are most likely to survive is a REGEXP-ESCAPED spelling — the
// Traefik `HostRegexp` wildcard leg takes a Go regexp, so the operator recipes,
// `DOMAIN_REGEX` in .env.example and the ops docs all quote the host as
// `sturaos\.com` (and, inside a YAML double-escape, `sturaos\\.com`). A pattern
// written `/sturaos\.com/` matches only the bare spelling and walks straight
// past every one of those, reporting clean. Allow zero or more backslashes
// between the label and the dot so the guard sees all three spellings.
const RETIRED_HOSTS = [/sturaos\\*\.com/i, /(^|[^A-Za-z0-9.-])stura\\*\.org/i]
// Empty prefix list = every tracked file. Kept as a list, not deleted, so a
// future carve-out is a one-line addition with a reason next to it rather than
// a rewrite of the filter below.
const RETIRED_HOST_SCOPE = []
// A guard must be able to quote what it forbids: this file, and the BATS test
// asserting .env.example carries no unowned domain in a value line.
const RETIRED_HOST_EXEMPT = [
  /^scripts[/]kernel-hygiene-check[.]mjs$/,
  /^test[/]setup[.]bats$/,
  SPEC_DOCS_REL, // B0: the approved design specs — see the carve-out note at (a5)
]

check('i1 no retired or unowned host appears in a shipped deploy, contract, CI or doc surface', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((rel) => RETIRED_HOST_SCOPE.length === 0 || RETIRED_HOST_SCOPE.some((pre) => rel.startsWith(pre)))
    .filter((rel) => !RETIRED_HOST_EXEMPT.some((re) => re.test(rel)))
  if (files.length === 0) return 'scope matched zero files - the check would vacuously pass'
  const offenders = []
  for (const rel of files) {
    if (/\.(png|jpe?g|gif|svg|ico|pdf|woff2?)$/i.test(rel)) continue
    const abs = join(ROOT, rel)
    if (!existsSync(abs)) continue
    readFileSync(abs, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (RETIRED_HOSTS.some((re) => re.test(line))) offenders.push(`${rel}:${i + 1}`)
      })
  }
  return offenders.length
    ? `retired/unowned host still shipped in ${offenders.length} place(s): ${offenders.join(' | ')}`
    : null
})

// -- (i2) the shipped contact defaults must be documentation names ----------
//
// (i1) above forbids two SPECIFIC retired hosts. This one is the general rule
// they were instances of, applied to the one surface where a wrong host is not
// a dead link but a legal statement: the e-mail addresses a deployer inherits
// by copying an env template.
//
// `scripts/setup.sh` copies `legal/legal.env.example` to `legal/legal.env` and
// `.env.example` to `.env` on every fresh install, unedited. The legal service
// then substitutes ORG_EMAIL and RESPONSIBLE_PERSON_EMAIL into live `mailto:`
// links in `docker/legal/templates/{impressum,datenschutz,nutzungsbedingungen,
// barrierefreiheit}.html`, and gremion-public renders PUBLIC_CONTACT_EMAIL on
// `/` and `/kontakt`. So a default here is published as the TMG 5 Impressum
// contact and the GDPR Art. 13 controller contact of a real deployment.
//
// It bit three times: `info@stura-muster.de` / `datenschutz@stura-muster.de` in
// legal.env.example, `rat@hs.example.de` in .env.example, and
// `PUBLIC_BASE_URL=https://example.de` in gremion-ui/.env.example. `.de` is a
// registrable TLD -- RFC 2606 reserves example.com/.net/.org and the
// .example/.invalid/.test/.localhost TLDs, and NOT example.de -- so a stranger
// could register any of those names and receive the data-subject requests, or
// the traffic, of every install that shipped with the default.
//
// The rule is the reservation, not a blocklist of the names that failed: a host
// in a value position of a tracked env template must be either
//   - a name IANA reserves for documentation, or
//   - a dotless name, which can only be a compose service or container alias.
// Nothing else can be verified as a name this project is entitled to point at.
const ENV_TEMPLATE = /(^|[/])[A-Za-z0-9._-]*\.?env\.example$/
const RESERVED_HOST = /(^|\.)(example\.(com|net|org)|example|invalid|test|localhost)$/i
// Value position only: everything after the first `=`, comments included, since
// a commented `# e.g. https://...` is a recipe a deployer copies.
const VALUE_LINE = /^[A-Z0-9_]+=(.*)$/
const HOST_IN_VALUE = /(?:[A-Za-z0-9._%+-]+@|https?:\/\/)([A-Za-z0-9.-]+)/g

check('i2 every host in a shipped env template value is a reserved documentation name', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((rel) => ENV_TEMPLATE.test(rel))
  if (files.length === 0) return 'no env template matched - the check would vacuously pass'
  const offenders = []
  let hosts = 0
  for (const rel of files) {
    read(rel)
      .split('\n')
      .forEach((line, i) => {
        const v = VALUE_LINE.exec(line.trim())
        if (!v) return
        for (const m of v[1].matchAll(HOST_IN_VALUE)) {
          const host = m[1].replace(/\.$/, '')
          hosts++
          if (!host.includes('.')) continue // compose service / container alias
          if (RESERVED_HOST.test(host)) continue
          offenders.push(`${rel}:${i + 1} ${host}`)
        }
      })
  }
  if (hosts === 0) return 'no host found in any env template value - the check would vacuously pass'
  return offenders.length
    ? `${offenders.length} default(s) point at a domain this project does not own: ${offenders.join(' | ')}`
    : null
})

// -- (j) the k8s apex/regex sentinel pair must be substituted TOGETHER --------
//
// The production ingressroute patches carry two sentinels that describe ONE
// domain: `__GREMION_DOMAIN__` (the apex, a Traefik Host literal) and
// `__GREMION_DOMAIN_REGEX__` (the same apex with its dots backslash-escaped,
// used inside a Go regexp on the tenant wildcard leg). Route 2 of
// gremion-ui-https consumes both in a single match expression.
//
// Substituting only one is admitted by the API server and logged by nobody: the
// apex answers normally while every tenant subdomain 404s at Traefik. That is
// the failure .env.example flags as LOAD-BEARING for compose's DOMAIN_REGEX,
// and gremion-ui/scripts/check-domain-regex.mjs is its compose-side detector.
// This is the k8s-side equivalent; without it the half-substituted state is
// invisible until a tenant reports a dead subdomain.
//
// The apex also reaches keycloak-domain.yaml as the realm-import `DOMAIN`, so
// the scan covers the whole production patches/ directory rather than just the
// ingressroutes: routes substituted without that ConfigMap means Traefik serves
// the apex while Keycloak refuses every login on it.
//
// At HEAD both sentinels are intact, so this check passes on the shipped tree.
// It bites on the OPERATOR's tree, after they run the sed recipe in
// k8s/overlays/production/patches/ingressroutes-prod/gremion-ui-https.yaml.
const K8S_PROD_PATCH_DIR = 'k8s/overlays/production/patches/'
const APEX_SENTINEL = '__GREMION_DOMAIN__'
const REGEX_SENTINEL = '__GREMION_DOMAIN_REGEX__'

check('j1 the k8s apex and escaped-domain sentinels resolve to the same domain', () => {
  const files = execFileSync('git', ['ls-files', K8S_PROD_PATCH_DIR], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (files.length === 0) return 'no production ingressroute patches matched - the check would vacuously pass'

  const apexes = new Map() // value -> first "file:line" that used it
  const escaped = new Map()
  for (const rel of files) {
    const abs = join(ROOT, rel)
    if (!existsSync(abs)) continue
    readFileSync(abs, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (line.trim().startsWith('#')) return // the recipe comment is not a route
        const where = `${rel}:${i + 1}`
        // HostRegexp(`^[a-z0-9-]+\.<escaped>$`) — the tenant wildcard leg.
        for (const m of line.matchAll(/HostRegexp\(`\^\[a-z0-9-\]\+\\\.(.+?)\$`\)/g)) {
          if (!escaped.has(m[1])) escaped.set(m[1], where)
        }
        // Host(`<apex>`) — note HostRegexp( cannot match here ("Host" + "R").
        for (const m of line.matchAll(/Host\(`([^`]+)`\)/g)) {
          if (!apexes.has(m[1])) apexes.set(m[1], where)
        }
        // The apex-host middleware injects default.<apex> as X-Forwarded-Host.
        const dm = line.match(/^\s*value:\s*default\.(\S+)\s*$/)
        if (dm && !apexes.has(dm[1])) apexes.set(dm[1], where)
        // keycloak-domain.yaml: the same apex as the realm import's DOMAIN.
        const km = line.match(/^\s*DOMAIN:\s*(\S+)\s*$/)
        if (km && !apexes.has(km[1])) apexes.set(km[1], where)
      })
  }
  if (apexes.size === 0 || escaped.size === 0) {
    return `expected both an apex and an escaped-domain occurrence; found ${apexes.size} apex / ${escaped.size} escaped`
  }
  const fmt = (m) => [...m].map(([v, w]) => `${v} (${w})`).join(', ')
  if (apexes.size > 1) return `the apex sentinel resolved inconsistently: ${fmt(apexes)}`
  if (escaped.size > 1) return `the escaped-domain sentinel resolved inconsistently: ${fmt(escaped)}`

  const [apex] = [...apexes.keys()]
  const [esc] = [...escaped.keys()]
  const apexIsSentinel = apex === APEX_SENTINEL
  const escIsSentinel = esc === REGEX_SENTINEL
  if (apexIsSentinel && escIsSentinel) return null // shipped state: nothing substituted
  if (apexIsSentinel !== escIsSentinel) {
    return `half-substituted domain sentinels: apex is "${apex}" but the wildcard regexp is "${esc}" — the apex would answer while EVERY tenant subdomain 404s at Traefik. Substitute both, or neither.`
  }
  const expected = apex.split('.').join('\\.')
  return esc === expected
    ? null
    : `the wildcard regexp does not describe the apex: apex "${apex}" implies "${expected}", found "${esc}" (${escaped.get(esc)}) — every tenant subdomain would 404 at Traefik.`
})

// ── (t) the Keycloak login theme is internally consistent ──────────────────
//
// Keycloak answers a broken theme by falling back to the stock one, with no
// error in any log and a 200 on the login page. So every reference inside the
// theme is checked as a PATH THAT RESOLVES, not as a string that looks right:
//   t1 - realm-export.base.json's loginTheme names a directory that exists;
//        that directory's theme.properties `styles=` names a file that exists;
//        every ${url.resourcesPath}/… href in every .ftl names a file that exists.
//   t3 - the three message bundles define the IDENTICAL key set, and no key is
//        dead (every key defined in the default bundle is used by some .ftl).
// Together they make a half-finished rename impossible to commit: move the
// directory without theme.properties and t1 goes red; rename a key in one
// bundle and t3 goes red; rename a key everywhere but in the markup and t3's
// dead-key leg goes red.
//
// The `t` series, not `j`: j1-j4 belong to B18-router-emitter-library's edge
// rules, and j1 is already the k8s apex/escaped-domain sentinel check above.
const THEME_ROOT = 'docker/keycloak/themes'

function themeName() {
  return JSON.parse(read('docker/keycloak/realm-export.base.json')).loginTheme
}

function themeFtls(theme) {
  const dir = join(ROOT, THEME_ROOT, theme, 'login')
  return existsSync(dir)
    ? readdirSync(dir).filter((n) => n.endsWith('.ftl')).map((n) => `${THEME_ROOT}/${theme}/login/${n}`)
    : []
}

check('t1 every path the login theme references resolves on disk', () => {
  const theme = themeName()
  if (!theme) return 'realm-export.base.json declares no loginTheme'
  const loginDir = `${THEME_ROOT}/${theme}/login`
  if (!has(loginDir)) return `loginTheme "${theme}" names no directory at ${loginDir}`
  const props = read(`${loginDir}/theme.properties`)
  const styles = /^styles=(.+)$/m.exec(props)
  if (!styles) return `${loginDir}/theme.properties declares no styles=`
  const missing = []
  for (const s of styles[1].trim().split(/\s+/)) {
    if (!has(`${loginDir}/resources/${s}`)) missing.push(`theme.properties styles= names ${s}, absent at ${loginDir}/resources/${s}`)
  }
  // The GENERATED export, while it still exists, is a second declaration of the
  // same value. It is composed from the base template, so a rename that moves
  // only the base leaves a fresh `--import-realm` boot pointing at a directory
  // that is gone — the silent stock-theme fallback again, one file further out.
  if (has('docker/keycloak/realm-export.json')) {
    const gen = JSON.parse(read('docker/keycloak/realm-export.json')).loginTheme
    if (gen !== theme) {
      missing.push(`realm-export.json declares loginTheme "${gen}" but realm-export.base.json declares "${theme}" — regenerate it (make gen-realm)`)
    }
  }
  const ftls = themeFtls(theme)
  if (ftls.length === 0) return `found zero .ftl under ${loginDir} — the check would vacuously pass`
  for (const rel of ftls) {
    for (const m of read(rel).matchAll(/\$\{url\.resourcesPath\}\/([A-Za-z0-9._/-]+)/g)) {
      if (!has(`${loginDir}/resources/${m[1]}`)) missing.push(`${rel} references ${m[1]}, absent at ${loginDir}/resources/${m[1]}`)
    }
  }
  return missing.length ? `${missing.length} unresolved theme reference(s): ${missing.join(' | ')}` : null
})

// t2 - no message key in the theme carries the retired product token. The keys
// are an API between the bundles and the markup, so a stale one is invisible
// until a login page renders a raw ??key?? placeholder to a user.
const RETIRED_KEY_PREFIX = /^sturaos/i

check('t2 no login-theme message key carries the retired product token', () => {
  const theme = themeName()
  const loginDir = `${THEME_ROOT}/${theme}/login`
  const offenders = []
  for (const b of ['messages.properties', 'messages_de.properties', 'messages_en.properties']) {
    read(`${loginDir}/messages/${b}`).split('\n').forEach((line, i) => {
      const m = /^([A-Za-z][A-Za-z0-9_.]*)=/.exec(line.trim())
      if (m && RETIRED_KEY_PREFIX.test(m[1])) offenders.push(`${loginDir}/messages/${b}:${i + 1} ${m[1]}`)
    })
  }
  for (const rel of themeFtls(theme)) {
    read(rel).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/msg\(\s*"([^"]+)"/g)) {
        if (RETIRED_KEY_PREFIX.test(m[1])) offenders.push(`${rel}:${i + 1} ${m[1]}`)
      }
    })
  }
  return offenders.length
    ? `${offenders.length} retired-token message key(s): ${offenders.join(' | ')}`
    : null
})

check('t3 the three message bundles agree and carry no dead key', () => {
  const theme = themeName()
  const loginDir = `${THEME_ROOT}/${theme}/login`
  const bundles = ['messages.properties', 'messages_de.properties', 'messages_en.properties']
  const keysOf = (b) =>
    new Set(read(`${loginDir}/messages/${b}`).split('\n')
      .map((l) => /^([A-Za-z][A-Za-z0-9_.]*)=/.exec(l.trim()))
      .filter(Boolean).map((m) => m[1]))
  const sets = bundles.map((b) => [b, keysOf(b)])
  const base = sets[0][1]
  if (base.size === 0) return 'the default bundle defines zero keys — the check would vacuously pass'
  const problems = []
  for (const [b, s] of sets.slice(1)) {
    for (const k of base) if (!s.has(k)) problems.push(`${k} missing from ${b}`)
    for (const k of s) if (!base.has(k)) problems.push(`${k} extra in ${b}`)
  }
  const markup = themeFtls(theme).map((r) => read(r)).join('\n')
  const used = new Set([...markup.matchAll(/msg\(\s*"([^"]+)"/g)].map((m) => m[1]))
  for (const k of base) if (!used.has(k)) problems.push(`${k} is defined but referenced by no .ftl`)
  return problems.length ? `${problems.length} message-bundle problem(s): ${problems.join(' | ')}` : null
})

// t4 - the theme's own fallback literal for realm.displayName.
//
// WHAT THIS CHECK IS AND IS NOT, corrected in round 1 against a running
// Keycloak 26.6.1 rather than assumed. The `!'...'` default is UNREACHABLE at
// runtime: RealmBean.getDisplayName() returns the realm NAME when displayName
// is unset, so the expression is never null and the default never fires. A
// realm called `themeclean` renders `<title>Anmelden - themeclean</title>` and
// `<div class="n">themeclean</div>`, measured on the served page. So this is
// NOT 'the string a user sees when the tenant sets nothing' - the eight old
// retired-name literals were equally unreachable.
//
// It is still worth having, for the reason a dead brand literal is always worth
// removing: it is a latent trap. Any change that makes the expression genuinely
// absent - a different bean, a template that iterates realms, a Keycloak
// release that stops substituting - renders whatever literal is sitting there
// to a user. t4 pins WHICH literal is sitting there. The live counterpart runs
// in test/integration/login-theme.bats, which pins the realm name at both
// render sites instead, because that is what the page actually shows.
const DISPLAYNAME_FALLBACK = /\(realm\.displayName\)!'([^']*)'/g
const EXPECTED_FALLBACK = 'Gremion'

check('t4 the login theme falls back to the kernel name, not the retired one', () => {
  const theme = themeName()
  const offenders = []
  let seen = 0
  for (const rel of themeFtls(theme)) {
    read(rel).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(DISPLAYNAME_FALLBACK)) {
        seen++
        if (m[1] !== EXPECTED_FALLBACK) offenders.push(`${rel}:${i + 1} '${m[1]}'`)
      }
    })
  }
  if (seen === 0) return 'found zero realm.displayName fallbacks — the check would vacuously pass'
  return offenders.length
    ? `${offenders.length} of ${seen} realm.displayName fallback(s) render a name other than "${EXPECTED_FALLBACK}": ${offenders.join(' | ')}`
    : null
})

// ── (t5) no integration suite is orphaned ─────────────────────────────────
//
// The Makefile already says this out loud, twelve lines below the target it is
// about: "a target nothing aggregates is a target nobody runs, which is how the
// JetStream proofs went unexecuted in the first place (integration defect D8)".
// The same hole exists one level down: `make test-integration` and ci.yml both
// enumerate integration suites FILE BY FILE, so a new test/integration/*.bats
// is committed, reviewed, and then never executed by anything, forever, with
// nothing red to say so. login-theme.bats was added in exactly that state.
//
// Post-condition, not exit code: every .bats file under test/integration is
// named in the test-integration recipe AND in the CI step that runs bats.
const INTEGRATION_DIR = 'test/integration'
// ONE exemption from the CI leg, and it is a service dependency, not a
// preference: legal.bats drives the `legal` service on :8083, which the CI
// integration job does not start (it brings up postgres + keycloak only). It IS
// named by `make test-integration`, so it is aggregated, not orphaned. Opened
// 2026-09-16; it goes away when CI starts the legal service.
const CI_BATS_EXEMPT = ['legal.bats']

check('t5 every integration bats suite is named by make test-integration and by CI', () => {
  const dir = join(ROOT, INTEGRATION_DIR)
  if (!existsSync(dir)) return `${INTEGRATION_DIR} does not exist - the check would vacuously pass`
  const suites = readdirSync(dir).filter((n) => n.endsWith('.bats')).sort()
  if (suites.length === 0) return `found zero .bats under ${INTEGRATION_DIR} - the check would vacuously pass`
  const makefile = read('Makefile')
  const recipe = /^test-integration:[^]*?(?=^[A-Za-z0-9_.-]+:|^# )/m.exec(makefile)
  if (!recipe) return 'Makefile declares no test-integration target - the check would vacuously pass'
  const ci = read('.github/workflows/ci.yml')
  // Any LIVE bats invocation naming an integration suite, `run: bats ...` or a
  // bats line inside a `run: |` block. Commented-out lines do not count: a
  // suite is not run by a `#`.
  const ciSteps = ci.split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .filter((l) => /\bbats\b/.test(l) && l.includes(`${INTEGRATION_DIR}/`))
    .join(' ')
  if (!ciSteps) return 'ci.yml runs bats nowhere - the check would vacuously pass'
  const missing = []
  for (const n of suites) {
    const rel = `${INTEGRATION_DIR}/${n}`
    if (!recipe[0].includes(rel)) missing.push(`${rel} is not named by make test-integration`)
    if (!CI_BATS_EXEMPT.includes(n) && !ciSteps.includes(rel)) {
      missing.push(`${rel} is not named by any ci.yml bats step`)
    }
  }
  return missing.length
    ? `${missing.length} orphaned integration suite reference(s): ${missing.join(' | ')}`
    : null
})

// ── (e6) the production Secret template carries every client secret the ──────
//        per-tenant realm template still needs
//
// B-01 deleted the boot import, so nothing substitutes the realm template's
// `__*_CLIENT_SECRET__` sentinels at container start any more — buildTenantRealmDoc
// places them at tenant-create time, reading the values out of the keycloak
// Secret. A key dropped from k8s/overlays/production/secrets/_templates.example.yaml
// is therefore SILENT: kustomize renders, Keycloak starts, and the miss only
// surfaces much later as a tenant whose client has no secret. Post-condition:
// every client-secret sentinel the realm template carries has a stringData key
// of the same name in the keycloak Secret document.
check('e6 every client-secret sentinel in the realm template has a key in the production keycloak Secret', () => {
  const tmplPath = 'k8s/overlays/production/secrets/_templates.example.yaml'
  if (!has(tmplPath)) return `${tmplPath} missing - the check would vacuously pass`
  const base = read('docker/keycloak/realm-export.base.json')
  const sentinels = [
    ...new Set([...base.matchAll(/__([A-Z0-9_]*_CLIENT_SECRET)__/g)].map((m) => m[1])),
  ]
  if (sentinels.length === 0) {
    return 'realm-export.base.json carries zero client-secret sentinels - the check would vacuously pass'
  }
  const doc = /name:[ \t]*keycloak-secret[^]*?(?=\n---)/.exec(read(tmplPath))
  if (!doc) return `${tmplPath} declares no keycloak-secret document - the check would vacuously pass`
  const missing = sentinels.filter((k) => !new RegExp(`^[ \t]+${k}:`, 'm').test(doc[0]))
  return missing.length
    ? `${tmplPath} keycloak-secret lacks ${missing.length} client-secret key(s) buildTenantRealmDoc needs: ${missing.join(', ')}`
    : null
})

// ── (t6) the CI integration job creates the realm it tests ──────────────────
//
// B-01 deleted the boot import, so the realm test/integration/login-theme.bats
// reads the SERVED login page from has to be created by the job itself. The
// first draft of this wiring derived the realm under test from the realm
// TEMPLATE's `realm` field — which B-01 turns into the `__REALM_NAME__`
// sentinel. Nothing creates a realm by that name, login-theme.bats skips only
// on an EMPTY value, and the step rejects skips on purpose, so the whole
// live-Keycloak step went red for a reason that reads as a theme bug.
//
// Post-conditions, read off ci.yml itself: the realm under test is never
// derived from the template, and the job creates a realm BEFORE the line that
// runs the suite.
check('t6 the CI integration job creates the realm under test and never derives it from the realm template', () => {
  const ci = read('.github/workflows/ci.yml')
  const start = ci.indexOf('\n  integration-test:\n')
  if (start < 0) return 'ci.yml declares no integration-test job - the check would vacuously pass'
  const rest = ci.slice(start + 1)
  const next = /\n {2}[A-Za-z0-9_-]+:\n/.exec(rest.slice(1))
  const job = next ? rest.slice(0, next.index + 1) : rest
  const lines = job.split('\n').filter((l) => !/^\s*#/.test(l))

  const assigns = lines.filter((l) => /\bTHEME_REALM=/.test(l))
  if (assigns.length === 0) return 'the integration job never sets THEME_REALM - the check would vacuously pass'
  const fromTemplate = assigns.filter((l) => /realm-export(\.base)?\.json/.test(l))
  if (fromTemplate.length) {
    return `THEME_REALM is derived from the realm TEMPLATE, whose realm field is the __REALM_NAME__ sentinel: ${fromTemplate.join(' | ').trim()}`
  }

  const batsIdx = lines.findIndex((l) => /\bbats\b/.test(l) && l.includes('test/integration/login-theme.bats'))
  if (batsIdx < 0) return 'the integration job runs login-theme.bats nowhere - the check would vacuously pass'
  const createIdx = lines.findIndex((l) => /-X POST\b/.test(l) && /\/admin\/realms\b/.test(l))
  if (createIdx < 0) {
    return 'the integration job never creates a realm (no POST to /admin/realms), so login-theme.bats has no realm to read'
  }
  if (createIdx > batsIdx) {
    return `the realm is created at line ${createIdx + 1} of the job, AFTER login-theme.bats runs at line ${batsIdx + 1}`
  }

  const fixture = 'test/integration/fixtures/render-realm-fixture.py'
  if (job.includes('render-realm-fixture.py') && !has(fixture)) {
    return `the integration job calls ${fixture}, which does not exist`
  }
  return null
})

// ── (e7) nothing still tells a reader that Keycloak imports a realm at boot ──
//
// B-01 deleted the boot import. The kernel is PUBLIC, so a doc line that still
// says "Keycloak imports this file at boot" is a shipped instruction that does
// not work — and the compose/k8s change that removed the mechanism cannot fail
// because of it. Two legs:
//   A. `--import-realm` survives ONLY in the guards that assert its absence.
//   B. no tracked file AFFIRMS the import in prose. The pattern pairs `import`
//      with a realm noun on one line and drops lines that negate it, so the
//      B-01 sentences that say no realm is imported are not hits.
const IMPORT_REALM_CARRIERS = new Set([
  'test/integration/health.bats',        // asserts the rendered compose has none
  'scripts/kernel-hygiene-check.mjs',    // this file
  'docker/keycloak/README.md',           // states the boot import is gone
  'docs/deployment.md',                  // same, as the B-01 note
])

// The two operator-approved design specs that B0 tracks are the FROZEN record
// of this very change: they name `--import-realm` as the argument the work
// deletes, and they are committed byte-identical to the approved originals
// (which is why .gitattributes pins them to LF), so they cannot be reworded to
// satisfy a guard. They are a design record, never an instruction to a reader.
// Exactly these two paths are exempt — e7 keeps its tree-wide scope everywhere
// else, and if the spec files are ever renamed this pattern matches nothing and
// e7 goes red on them again rather than silently widening. h2 above carves the
// same directory out for the same reason.
const DESIGN_SPEC_RECORD = /^docs\/superpowers\/specs\/spec-[bd]-[^/]+\.md$/

function trackedGrep(args) {
  const res = spawnSync('git', ['grep', '-n', ...args], { cwd: ROOT, encoding: 'utf8' })
  // exit 1 with empty stdout = no match; anything else with stderr is a real error.
  if (res.status > 1) throw new Error(`git grep failed: ${res.stderr.trim()}`)
  return (res.stdout || '').split('\n').filter(Boolean)
}

check('e7 no tracked file outside the guards still describes the deleted Keycloak boot import', () => {
  const argHits = trackedGrep(['-e', '--import-realm'])
  if (argHits.length === 0) return 'no file names --import-realm at all - the guards that assert its absence are gone, so the check is vacuous'
  const strayArg = argHits
    .map((l) => [l, l.split(':')[0]])
    .filter(([, file]) => !IMPORT_REALM_CARRIERS.has(file) && !DESIGN_SPEC_RECORD.test(file))
    .map(([l]) => l)

  // Affirmative prose, two shapes: an import claim tied to BOOT time, and the
  // specific retired claims about the realm export. `kc.sh import` is excluded:
  // importing a realm into a RUNNING Keycloak by hand (the restore runbook) is
  // a live operation, not the deleted boot path.
  // git grep is line-based, so `.` cannot cross a line.
  const BOOT_CLAIM = 'import[a-z]*.{0,80}(at boot|at container start|at startup)|(at boot|at container start|at startup).{0,80}import[a-z]*'
  const RETIRED_CLAIM = 'realm import|imports? the (kernel )?realm|realm-export.{0,40}is imported|substituted into .{0,40}realm-export'
  // Scope is the WHOLE tracked tree, which is what this check's name promises.
  // A directory allowlist here READ complete and was not: `.github/`, `k8s/`,
  // `infra/` and `.env*` were unreachable, so affirmative claims stood in the
  // public kernel while the check reported green (round-2 review finding).
  // Widening it to `--` turned the check RED on four lines; they are fixed in
  // the same commit.
  const SCOPE = ['--']
  const proseHits = [
    ...trackedGrep(['-iE', BOOT_CLAIM, ...SCOPE]),
    ...trackedGrep(['-iE', RETIRED_CLAIM, ...SCOPE]),
  ].filter((l) => !/kc\.sh import/.test(l))
  const stray = proseHits.filter((l) => {
    const [file] = l.split(':')
    if (IMPORT_REALM_CARRIERS.has(file)) return false
    if (DESIGN_SPEC_RECORD.test(file)) return false
    const text = l.slice(l.indexOf(':', l.indexOf(':') + 1) + 1)
    // B-01 sentences state the NEGATIVE; those are the documentation we want.
    return !/\b(no|not|never|nothing|deleted|removed|stopped)\b/i.test(text)
  })

  const problems = [...new Set([...strayArg, ...stray])].sort()
  return problems.length
    ? `${problems.length} line(s) still describe a boot-time realm import:\n    ${problems.join('\n    ')}`
    : null
})

// ── (e8) docs/ENVIRONMENT.md documents no knob that no longer exists ────────
//
// B-01 deleted `KC_REALM_SSL_REQUIRED` from docker-compose.yml and from the dev
// override, and docs/ENVIRONMENT.md went on documenting it - Type, Default,
// Used by, Impact - one section above a paragraph the same commit corrected.
// Nothing compared the two surfaces, so the file contradicted itself silently.
// Post-condition: every environment variable with its own `### NAME` section in
// docs/ENVIRONMENT.md still has at least one LIVE carrier outside docs/ - a
// line that is not a comment. A knob whose only remaining carriers are comments
// is documentation of a mechanism that was removed.
check('e8 every env var with its own section in docs/ENVIRONMENT.md still has a live carrier', () => {
  const doc = read('docs/ENVIRONMENT.md')
  const documented = [...doc.matchAll(/^### ([A-Z][A-Z0-9_]{2,})$/gm)].map((m) => m[1])
  if (documented.length === 0) return 'docs/ENVIRONMENT.md declares no ### VAR sections - the check would vacuously pass'
  const dead = []
  for (const name of documented) {
    const res = spawnSync('git', ['grep', '-n', '-e', name, '--', ':!docs/', ':!*.md'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    if (res.status > 1) throw new Error(`git grep failed for ${name}: ${res.stderr.trim()}`)
    const live = (res.stdout || '')
      .split('\n')
      .filter(Boolean)
      .filter((l) => {
        const text = l.slice(l.indexOf(':', l.indexOf(':') + 1) + 1)
        return !/^\s*(#|\/\/|--|\*)/.test(text)
      })
    if (live.length === 0) dead.push(name)
  }
  return dead.length
    ? `docs/ENVIRONMENT.md documents ${dead.length} knob(s) with no live carrier left (comments only): ${dead.join(', ')}`
    : null
})

// ── (k) no spec-A host literal in a tracked kernel DOCUMENT ────────────────
//
// Spec A §A names the operator's machine: an IPv4 prefix, an IPv6 allocation,
// an inventory name, the provider's default hostname, an FQDN and a registrar.
// This repository is public. test/host/no-host-literals.bats already scans the
// whole tree for the same six under `make test-unit`; this rule is the
// docs-surface half that runs under `make lint-hygiene`, so a leak introduced
// by a documentation change is caught by the lint a docs PR actually runs.
// Two homes, one enumeration kept in step by test/host/spec-docs.bats.
//
// Id allocation (binding contract): k1 is THIS rule. `k2` — no vertical or
// Civitas literal outside verticals/ — belongs to D8 and is not defined here.
//
// NO WHOLE SPELLING IS COMMITTED HERE. Each pattern and each sample is built
// from fragments at run time, because the tree-wide bats scan covers this file
// too and a guard is not exempt from the rule it enforces.
//
// Separators are negated classes with a {0,2} bound rather than escaped dots:
// a host survives longest in its regexp-escaped form (a HostRegexp leg, a
// DOMAIN_REGEX value, an nft comment), and over-matching is the safe direction
// for a leak guard.
//
// host-inventory-name closes its token on the right with ([^a-z]|$): without
// it "prod" also matches as the prefix of "production", and AM-B-05's binding
// contract key GREMION_PRODUCTION_STACK (spec B) is a legitimate env-key
// name, not the host's inventory name.
//
// One entry per line for `name:`, at four-space indent: test/host/spec-docs.bats
// counts those lines to prove this enumeration and the bats one stay in step.
const HOST_LITERALS = [
  {
    name: 'edge-ipv4-prefix',
    re: '159' + '[^0-9]{0,2}' + '195' + '[^0-9]',
    sample: '159' + '.195' + '.10.20',
  },
  {
    name: 'ipv6-allocation-prefix',
    re: '2a0a' + '[^0-9a-z]{0,2}' + '4cc0',
    sample: '2a0a' + ':' + '4cc0::1',
  },
  {
    name: 'host-inventory-name',
    re: 'gremion' + '[^a-z0-9\\s]{1,2}' + 'prod' + '([^a-z]|$)',
    sample: 'gremion-' + 'prod',
  },
  {
    name: 'provider-default-hostname',
    re: 'quick' + 'srv',
    sample: 'quick' + 'srv',
  },
  {
    name: 'host-fqdn',
    re: 'rs1' + '[^a-z0-9]{0,2}' + 'gremion' + '[^a-z0-9]{0,2}' + 'de',
    sample: 'rs1' + '.gremion' + '.de',
  },
  {
    name: 'registrar',
    re: 'in' + 'wx',
    sample: 'IN' + 'WX',
  },
]

// <name>|<path> — an occurrence that is provably not a host literal.
// registrar | docs/compliance/controller-processor-split.md
//   The Art. 28 sub-processor table names the registrar as a supplier: a
//   disclosure obligation, no address, no hostname, no credential. Same entry,
//   same reason, as test/host/no-host-literals.bats. The check below fails if
//   the occurrence goes away and this entry stays.
const HOST_LITERAL_EXEMPT = new Set([
  'registrar|docs/compliance/controller-processor-split.md',
])

check('k1 no spec-A host literal in a tracked kernel document', () => {
  const files = execFileSync('git', ['ls-files', '--', 'docs', 'README.md'], {
    cwd: ROOT, encoding: 'utf8',
  }).split('\n').map((s) => s.trim()).filter(Boolean)
  // Vacuity: a scan that reaches nothing reports clean.
  if (files.length < 20) {
    return `only ${files.length} tracked document(s) reached — the scan would pass vacuously`
  }
  const offenders = []
  const spent = []
  for (const lit of HOST_LITERALS) {
    const re = new RegExp(lit.re, 'i')
    // Dead-pattern self-proof: a pattern that stopped matching its own sample
    // would otherwise report the tree clean.
    if (!re.test(lit.sample)) return `pattern ${lit.name} no longer matches its own sample`
    let exemptHit = false
    for (const rel of files) {
      const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue
        if (HOST_LITERAL_EXEMPT.has(`${lit.name}|${rel}`)) { exemptHit = true; continue }
        offenders.push(`${lit.name} ${rel}:${i + 1}`)
      }
    }
    for (const entry of HOST_LITERAL_EXEMPT) {
      if (entry.split('|')[0] === lit.name && !exemptHit) spent.push(entry)
    }
  }
  if (spent.length) return `exemption(s) spent — the occurrence is gone, delete: ${spent.join(', ')}`
  return offenders.length
    ? `${offenders.length} spec-A host literal(s) in the public documentation surface: ${offenders.join(' | ')}`
    : null
})

// ── (m) the port-back provenance record ─────────────────────────
// Ten migrations entered the kernel from another repository. Without a record
// naming the source ref, the next reader cannot tell a ported file from one
// written here, and B6/B7 cannot re-derive the bytes they normalise and renumber.
check('m1 the port-back record names the frozen extraction source and all ten files', () => {
  const p = 'docs/ops/migration-portback-2026-09-15.md'
  if (!has(p)) return `${p} missing`
  const doc = read(p)
  const SOURCE = 'f276af5925abacdcfd05f6613fc11afff2d804c5'
  if (!doc.includes(SOURCE)) return `does not name the frozen extraction source ${SOURCE}`
  const ported = [
    '003_calendar_schema.sql', '034_deck_board.sql', '049_org_unit_event_outbox.sql',
    '053_notification_read_marker.sql', '054_resolution_adoption_mode.sql',
    '055_resolution_challenges.sql', '056_role_assignment_history_recalled.sql',
    '057_fk_hot_filter_indexes.sql', '058_public_reader_grants.sql',
    '004_tenant_domain.sql',
  ]
  const missing = ported.filter((f) => !doc.includes(f))
  return missing.length ? `does not name: ${missing.join(', ')}` : null
})

// ── (n) the migration inventory docs match the tree ────────────────────────
// The port-back added nine data-plane files and one control file. Three docs
// state inventory counts and name "absent" files by basename:
// gremion-ui/migrations/README.md (the ledger a contributor actually opens),
// README.md and docs/about-gremion.md. A doc that contradicts readdirSync is
// worse than no doc — it tells a reader a shipped migration does not exist.
// Derived from the tree, so a future port-back or extraction cannot leave it
// stale: every count below is read off disk, never written down twice.

const INVENTORY_DOCS = ['gremion-ui/migrations/README.md', 'README.md', 'docs/about-gremion.md']
const dataPlaneFiles = readdirSync(join(ROOT, 'gremion-ui', 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
const controlPlaneFiles = readdirSync(join(ROOT, 'gremion-ui', 'migrations-control'))
  .filter((f) => f.endsWith('.sql'))
  .sort()

check('n1 every inventory doc states the real data-plane and control-plane counts', () => {
  const wrong = []
  for (const p of INVENTORY_DOCS) {
    if (!has(p)) return `${p} missing`
    const doc = read(p)
    for (const [text, n] of [...doc.matchAll(/\*{0,2}(\d+)\*{0,2} (?:data-plane|governance) migrations/g)]
      .map((m) => [m[0], Number(m[1])])) {
      if (n !== dataPlaneFiles.length) wrong.push(`${p}: "${text}" but ${dataPlaneFiles.length} ship`)
    }
    for (const [text, n] of [...doc.matchAll(/\*{0,2}(\d+)\*{0,2} control(?:-plane)? migrations/g)]
      .map((m) => [m[0], Number(m[1])])) {
      if (n !== controlPlaneFiles.length) wrong.push(`${p}: "${text}" but ${controlPlaneFiles.length} ship`)
    }
  }
  return wrong.length ? wrong.join(' | ') : null
})

check('n2 the migrations ledger lists every shipped file and calls none of them absent', () => {
  const p = 'gremion-ui/migrations/README.md'
  if (!has(p)) return `${p} missing`
  const doc = read(p)
  const INVENTORY = '## What is here, what is not'
  const ABSENT = '### Migrations that exist in the product and not here'
  const i = doc.indexOf(INVENTORY)
  const a = doc.indexOf(ABSENT)
  if (i < 0 || a < 0 || a < i) return `${p} no longer has the inventory and absent sections in order`
  const inventory = doc.slice(i, a)
  const absent = doc.slice(a)
  const named = (text) => new Set([...text.matchAll(/`(\d{3,4}_[a-z0-9_]+\.sql)`/g)].map((m) => m[1]))
  const listed = named(inventory)
  const missing = [...dataPlaneFiles, ...controlPlaneFiles].filter((f) => !listed.has(f))
  const shipped = new Set([...dataPlaneFiles, ...controlPlaneFiles])
  const contradicted = [...named(absent)].filter((f) => shipped.has(f))
  const problems = []
  if (missing.length) problems.push(`inventory omits: ${missing.join(', ')}`)
  if (contradicted.length) problems.push(`calls shipped file(s) absent: ${contradicted.join(', ')}`)
  return problems.length ? problems.join(' | ') : null
})

check('n3 the "absent from the kernel" arithmetic is the product chain minus what ships', () => {
  const wrong = []
  for (const p of INVENTORY_DOCS) {
    const doc = read(p)
    const total = [...doc.matchAll(/\*{0,2}(\d+)\*{0,2} (?:in the (?:reference )?product|data-plane files)/g)]
      .map((m) => Number(m[1]))
    const absent = [...doc.matchAll(/\*{0,2}(\d+)\*{0,2} are absent/g)].map((m) => Number(m[1]))
    if (!total.length) continue
    const expected = total[0] - dataPlaneFiles.length
    for (const n of absent) {
      if (n !== expected) wrong.push(`${p}: says ${n} absent, but ${total[0]} - ${dataPlaneFiles.length} = ${expected}`)
    }
  }
  return wrong.length ? wrong.join(' | ') : null
})

// ── (j) the edge router emitter's perimeter (TASK-034) ─────────────────────
// Three post-conditions the per-tenant router library depends on, each watched
// RED on a seeded plant by packages/edge-routers/test/hygiene-j.test.ts:
//
//   j2  no CDN API token variable anywhere in the kernel. The edge issues its
//       own certificates over ACME HTTP-01; a CDN DNS-API credential in the
//       tree means a DNS-01/CDN path crept back, and it would be the one
//       secret able to repoint every tenant hostname.
//   j3  no carrier of the deleted StuRa edge planner (spec B B-06): not the
//       file, not an import of it, not its origin-server constant or its
//       NS-delegation renderer. Only renderTenantRouter emits routers.
//   j4  etc/edge is bind-mounted EXACTLY ONCE across the kernel compose files,
//       read-only, into the traefik service. The app process never holds a
//       writable mount of the router directory: an app-level compromise must
//       not be able to publish a Host() router.
//
// There is no j1: the StuRa j1 banned Vaultwarden, which is supported here
// (R8-4, TRD-263). The needles are assembled from parts so this file carries
// none of the literals it hunts for. docs/superpowers/specs/ is the B0
// carve-out (byte-identical approved specs that describe these deletions).

// The tracked-file list is read lazily, INSIDE the checks that need it: a
// module-level git call that throws (no git on PATH, not a work tree) would
// abort the whole run before the report, and every other verdict with it
// (merge train 4: g2's setup-first line vanished that way). Inside check() the
// same throw fails j2-j4 loudly as "threw" and the rest still report.
let jTrackedCache
function jTracked() {
  jTrackedCache ??= execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .filter((f) => !SPEC_DOCS_REL.test(f))
  return jTrackedCache
}
const J_BINARY = /\.(png|jpe?g|gif|ico|pdf|woff2?|ttf|otf|gz|tgz|zip)$/i

function jScan(needle) {
  const hits = []
  let scanned = 0
  for (const f of jTracked()) {
    if (J_BINARY.test(f)) continue
    const abs = join(ROOT, f)
    if (!existsSync(abs)) continue
    scanned++
    if (needle.test(f)) hits.push(`${f} (path)`)
    const lines = readFileSync(abs, 'utf8').split('\n')
    lines.forEach((l, i) => {
      if (needle.test(l)) hits.push(`${f}:${i + 1}`)
    })
  }
  return { hits, scanned }
}

const J_MIN_SCANNED = 200 // the kernel tracks ~1100 files; far fewer means the scan is looking at the wrong tree

check('j2 no CDN API token variable in the kernel', () => {
  // Every spelling Traefik/lego and the CDN's own tooling read for a DNS-01 /
  // API credential: <CF|CLOUDFLARE>_[DNS_|ZONE_]API_<TOKEN|KEY>, and the
  // account e-mail that pairs with a global key.
  const cdn = ['CF', ['CLOUD', 'FLARE'].join('')].join('|')
  const needle = new RegExp(
    `\\b(${cdn})_(DNS_|ZONE_)?API_(TOKEN|KEY)\\b|\\b(${cdn})_(API_)?EMAIL\\b`,
    'i',
  )
  const { hits, scanned } = jScan(needle)
  if (scanned < J_MIN_SCANNED) return `scanned only ${scanned} tracked file(s) — the scan proves nothing`
  return hits.length ? `found in: ${hits.join(' | ')}` : null
})

check('j3 no carrier of the deleted edge planner', () => {
  const needle = new RegExp(
    [
      ['edge', 'plan'].join('[-_.]?'),
      ['render', 'Ns', 'Delegation'].join(''),
      ['DEFAULT', 'ORIGIN', 'SERVER', 'NAME'].join('_'),
    ].join('|'),
    'i',
  )
  const { hits, scanned } = jScan(needle)
  if (scanned < J_MIN_SCANNED) return `scanned only ${scanned} tracked file(s) — the scan proves nothing`
  return hits.length ? `found in: ${hits.join(' | ')}` : null
})

// j4 reads the compose files as TEXT, because the question is about every
// spelling that could mount the directory — short syntax, long syntax, a
// parent directory, an inherited volume set — not about what one parser makes
// of one file. Scope: EVERY tracked *compose*.y(a)ml outside test/ (the ops and
// mail projects are deployed too; test/ fixtures are throwaway stacks such as
// edge-proto's). A line naming etc/edge that is neither a recognised
// short-syntax mount nor a long-syntax `source:` is itself a failure:
// unrecognised is not "not a mount".
//
// Sources are normalised (`//` and `/./` collapsed, trailing `/` dropped)
// before they are compared. A bind of an ANCESTOR of etc/edge (`/`, /opt,
// /opt/gremion, …/etc, ${GREMION_ROOT}, ${GREMION_ROOT}/etc) is a second view
// of the router directory: it must be read-only (node-exporter's `/:/rootfs:ro`
// is), and a writable one fails. `volumes_from` or `extends` naming traefik
// would hand its etc/edge mount — possibly writable — to another service, and
// fails outright. A source spelled through another variable (${EDGE_DIR})
// cannot be resolved from text and is not claimed to be caught.
const J_COMPOSE = /(^|\/)[^/]*compose[^/]*\.ya?ml$/i
const J_EDGE_DIR = /etc\/edge(?![A-Za-z0-9_-])/
const J_ANCESTORS = new Set(['/', '/opt', '/opt/gremion', '/opt/gremion/etc', '${GREMION_ROOT}', '${GREMION_ROOT}/etc', '$GREMION_ROOT', '$GREMION_ROOT/etc'])

function jNormalise(src) {
  let s = src.replace(/\/+/g, '/')
  while (s.includes('/./')) s = s.replace('/./', '/')
  if (s.length > 1) s = s.replace(/\/$/, '')
  return s
}

function jServiceAt(lines, i) {
  for (let k = i; k >= 0; k--) {
    const m = /^ {2}([A-Za-z0-9._-]+):\s*(#.*)?$/.exec(lines[k])
    if (m) return m[1]
    if (/^\S/.test(lines[k]) && !lines[k].startsWith('#')) return null
  }
  return null
}

/** The lines of the block opened at line i (same item, deeper indent). */
function jBlock(lines, i) {
  const indent = lines[i].search(/\S/)
  const out = [lines[i]]
  for (let k = i + 1; k < lines.length; k++) {
    if (lines[k].trim() === '' || /^\s*#/.test(lines[k])) continue
    if (lines[k].search(/\S/) <= indent) break
    out.push(lines[k])
  }
  return out
}

function jEdgeMounts() {
  const mounts = []
  const ancestors = []
  const problems = []
  const files = jTracked().filter((f) => J_COMPOSE.test(f) && !f.startsWith('test/') && existsSync(join(ROOT, f)))
  for (const f of files) {
    const lines = readFileSync(join(ROOT, f), 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (/^\s*#/.test(line)) return
      const where = `${f}:${i + 1}`
      const inherit = /^\s*(volumes_from|extends)\s*:/.exec(line)
      if (inherit && /traefik/.test(jBlock(lines, i).join('\n'))) {
        problems.push(`${where}: ${inherit[1]} names traefik in service ${jServiceAt(lines, i)} — it would inherit the etc/edge mount`)
        return
      }
      const short = /^\s*-\s*["']?([^"'\s]+)["']?\s*(#.*)?$/.exec(line)
      const long = /^(\s*)(?:-\s*)?source:\s*["']?([^"'\s]+)["']?\s*(#.*)?$/.exec(line)
      if (short && !/^\s*-\s*source:/.test(line) && short[1].includes(':')) {
        const parts = short[1].split(':')
        const src = jNormalise(parts[0])
        const opts = (parts[2] ?? '').split(',')
        const ro = opts.includes('ro')
        if (J_EDGE_DIR.test(src)) {
          mounts.push({ where, service: jServiceAt(lines, i), target: parts[1] ?? '', ro })
        } else if (J_ANCESTORS.has(src)) {
          ancestors.push({ where, service: jServiceAt(lines, i), src, ro })
        } else if (J_EDGE_DIR.test(line)) {
          problems.push(`${where}: etc/edge appears in a mount's target or options, not its source: ${line.trim()}`)
        }
        return
      }
      if (long) {
        const src = jNormalise(long[2])
        const isEdge = J_EDGE_DIR.test(src)
        if (!isEdge && !J_ANCESTORS.has(src)) return
        const indent = long[1].length
        let ro = false
        let target = ''
        // The rest of this list item: lines after `source:` at least as deep,
        // plus the lines before it up to the item's own `- ` marker.
        let start = i
        for (let k = i - 1; k >= 0; k--) {
          const depth = lines[k].search(/\S/)
          if (/^\s*-\s/.test(lines[k]) && depth < indent) {
            start = k
            break
          }
          if (depth < indent) break
          start = k
        }
        for (let k = start; k < lines.length; k++) {
          if (k > i && (lines[k].search(/\S/) < indent || /^\s*-\s/.test(lines[k]))) break
          if (/^\s*read_only:\s*["']?true["']?\s*(#.*)?$/.test(lines[k])) ro = true
          const t = /^\s*target:\s*["']?([^"'\s]+)/.exec(lines[k])
          if (t) target = t[1]
        }
        if (isEdge) mounts.push({ where, service: jServiceAt(lines, i), target, ro })
        else ancestors.push({ where, service: jServiceAt(lines, i), src, ro })
        return
      }
      if (J_EDGE_DIR.test(line)) {
        problems.push(`${where}: names etc/edge in a shape j4 cannot classify, so it cannot prove this is not a mount: ${line.trim()}`)
      }
    })
  }
  return { files, mounts, ancestors, problems }
}

check('j4 etc/edge is mounted exactly once, read-only, into traefik', () => {
  const { files, mounts, ancestors, problems } = jEdgeMounts()
  if (files.length === 0) return 'no kernel compose file found — the scan proves nothing'
  if (mounts.length !== 1) {
    problems.push(`${mounts.length} mounts of etc/edge (expected exactly 1): ${mounts.map((m) => `${m.where} [${m.service}]`).join(', ')}`)
  }
  for (const m of mounts) {
    if (!m.ro) problems.push(`${m.where}: the etc/edge mount in service ${m.service} is not read-only`)
    if (m.service !== 'traefik') problems.push(`${m.where}: etc/edge is mounted into service ${m.service}, not traefik`)
    if (m.target !== '/etc/traefik/dynamic') problems.push(`${m.where}: etc/edge is mounted at ${m.target || '(no target)'}, not /etc/traefik/dynamic`)
  }
  for (const a of ancestors) {
    if (!a.ro) problems.push(`${a.where}: service ${a.service} binds ${a.src}, an ancestor of etc/edge, WRITABLE — a second, writable view of the router directory`)
  }
  return problems.length ? problems.join(' | ') : null
})

// ── report ─────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`[kernel-hygiene] ${failures.length}/${checks.length} check(s) FAILED:`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`[kernel-hygiene] OK — ${checks.length} checks passed`)
