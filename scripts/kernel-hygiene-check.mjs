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
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
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
  if (!has('docker/keycloak/realm-export.json')) return 'docker/keycloak/realm-export.json missing'
  const forked = walk(join(ROOT, 'k8s')).filter((f) =>
    /(realm-export\.json|substitute-realm-secrets\.sh)$/.test(f)
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
// legal/legal.env, so `make lint` is RED out of the box on a fresh clone). Only
// the first is a defect in the repo. Say which one this is.
function missingLocalEnvFile(text) {
  const m = /env source files: \[([^\]]+)\]/.exec(text)
  if (m && /no such file|cannot find the file/i.test(text)) return m[1].trim()
  return null
}

check('g2 every overlay renders, and renders a non-zero number of image: lines', () => {
  const bad = overlayNames.map(renderOverlay).filter((r) => r.error || r.images.length === 0)
  if (!bad.length) return null
  return bad
    .map((r) => {
      if (!r.error) return `${r.name}: rendered zero image: lines`
      const missing = missingLocalEnvFile(r.error)
      return missing
        ? `${r.name}: NOT CHECKED — this working copy has no ${missing}; run scripts/setup.sh first. The overlay itself was not evaluated.`
        : `${r.name}: render FAILED — ${stderrCause(r.error)}`
    })
    .join(' | ')
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

// The first-party image coordinate. Was `gremion/<name>` — an UNQUALIFIED
// Docker Hub reference, i.e. docker.io/gremion/*, a namespace owned by an
// unrelated third party. It is now ghcr.io/hello-n00del/gremion-<service>,
// a namespace this project controls. Keep this regexp and the manifests in
// step: it is the one that decides whether g5 has anything to check at all.
const FIRST_PARTY_IMAGE = /(^|\/)ghcr\.io\/hello-n00del\/gremion-[a-z][a-z-]*(:|@|$)/

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

// g9 exists because g5 CANNOT see the defect it looks like it covers. g5 filters
// k8s/base image lines through FIRST_PARTY_IMAGE, so an image renamed AWAY from
// ghcr.io/hello-n00del/gremion-* simply stops matching and drops out of the set —
// injecting `image: docker.io/gremion/ui:0.1.0` into a base deployment left the
// whole run at "OK". Nor did anything read the docs: when every manifest was
// renamed to ghcr.io/hello-n00del/gremion-*, docs/deployment.md's deploy table
// and docs/OPERATIONS.md's "Update services" section kept the old names for the
// entire range, so a self-hoster copying them pulled from a stranger's registry.
//
// The two service names this is worth spelling out: `gremion/ui` is UNQUALIFIED,
// which Docker resolves to docker.io/gremion/ui — a Docker Hub namespace owned
// by an unrelated third party — and `docker compose pull` / `up --pull always`
// are exactly the commands a self-hoster runs.
//
// Scope is the surfaces a reader or a cluster ACTS on. .github/workflows/ci.yml
// and this file are deliberately outside it: both quote the bad coordinate in
// prose in order to explain why it is banned, and a guard that cannot survive
// its own rationale being written down gets deleted instead of obeyed.
const G9_SURFACE_DIRS = ['k8s', 'docs']
const G9_SURFACE_FILES = [
  'docker-compose.yml',
  'docker-compose.prod.yml',
  'docker-compose.override.yml',
  'README.md',
  'KNOWN_ISSUES.md',
  'Makefile',
]
// The five images this repo builds. Naming them individually (rather than
// `gremion/\w+`) keeps GitHub URLs such as .../Hello-N00del/gremion/issues —
// PUBLIC_SOURCE_URL's own neighbourhood — out of the match.
const G9_SERVICES = ['ui', 'public', 'legal', 'vector', 'fallback']
const G9_BAD_COORDINATE = new RegExp(
  String.raw`(?:^|[\s(\`'"=|])(docker\.io/gremion/[a-z][a-z0-9._-]*|gremion/(?:${G9_SERVICES.join('|')})\b)`,
  'i'
)
const G9_IMAGE_LINE = /^\s*(?:#\s*)?image:\s*["']?([^\s"']+)/

function g9Surfaces() {
  const out = []
  for (const dir of G9_SURFACE_DIRS) {
    if (!has(dir)) continue
    out.push(...walk(join(ROOT, dir)).map((f) => relative(ROOT, f).replace(/\\/g, '/')))
  }
  out.push(...G9_SURFACE_FILES.filter((f) => has(f)))
  return out.filter((f) => /\.(ya?ml|md)$/.test(f) || f === 'Makefile')
}

check('g9 no shipped manifest or deploy doc names a gremion image outside ghcr.io/hello-n00del', () => {
  const surfaces = g9Surfaces()
  const problems = []
  const seenServices = new Set()
  for (const rel of surfaces) {
    read(rel)
      .split('\n')
      .forEach((line, i) => {
        for (const m of line.matchAll(/ghcr\.io\/hello-n00del\/gremion-([a-z][a-z-]*)/g))
          seenServices.add(m[1])
        const img = G9_IMAGE_LINE.exec(line)
        if (img && /gremion/i.test(img[1]) && !FIRST_PARTY_IMAGE.test(img[1]))
          problems.push(`${rel}:${i + 1} image: ${img[1]} — not under ghcr.io/hello-n00del/`)
        const bad = G9_BAD_COORDINATE.exec(line)
        if (bad) problems.push(`${rel}:${i + 1} ${bad[1]} — resolves to a Docker Hub namespace we do not own`)
      })
  }
  // Vacuity guard: this check reads text, so a moved directory or a renamed
  // doc set would leave it scanning nothing and passing loudly. It only means
  // anything while the surfaces still carry all five first-party coordinates.
  const missing = G9_SERVICES.filter((s) => !seenServices.has(s))
  if (missing.length)
    return `saw no ghcr.io/hello-n00del/gremion-${missing.join(', gremion-')} coordinate across ${surfaces.length} scanned surface(s) — the scan is looking at the wrong tree, so its silence proves nothing`
  return problems.length ? problems.join(' | ') : null
})

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

// PATH CARVE-OUTS — two, and each is a place where `sturaos.` is provably not a
// subject:
//
//  - docker/keycloak/themes/sturaos/** — the Keycloak login theme is NAMED
//    sturaos, and its files reference `css/sturaos.v2.css`: a stylesheet
//    FILENAME that Keycloak serves by path. Renaming it 404s the login page.
//    Theme naming is the Gremion-rename ticket's job (gremion#21), not the wire
//    root's.
//  - scripts/kernel-hygiene-check.mjs — this file. It must be able to quote the
//    pattern it forbids; without the carve-out the guard can never pass, which
//    is the one failure mode that gets a guard deleted.
const WIRE_ROOT_EXEMPT_PATHS = [
  /^docker\/keycloak\/themes\/sturaos\//,
  /^scripts\/kernel-hygiene-check\.mjs$/,
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

// ── report ─────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`[kernel-hygiene] ${failures.length}/${checks.length} check(s) FAILED:`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`[kernel-hygiene] OK — ${checks.length} checks passed`)
