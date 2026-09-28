// g9 of scripts/kernel-hygiene-check.mjs: its surfaces and its scan, as
// functions of a root so scripts/kernel-hygiene-check.test.mjs can run them on
// a fixture tree in milliseconds instead of running the whole hygiene check
// (minutes under load) once per case. The hygiene check imports these; there
// is no second implementation.
//
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
// and the hygiene check are deliberately outside it: both quote the bad
// coordinate in prose in order to explain why it is banned, and a guard that
// cannot survive its own rationale being written down gets deleted instead of
// obeyed.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// The first-party image coordinate. Was `gremion/<name>` — an UNQUALIFIED
// Docker Hub reference, i.e. docker.io/gremion/*, a namespace owned by an
// unrelated third party. It is now ghcr.io/hello-n00del/gremion-<service>,
// a namespace this project controls. Keep this regexp and the manifests in
// step: it is the one that decides whether g5 has anything to check at all.
export const FIRST_PARTY_IMAGE = /(^|\/)ghcr\.io\/hello-n00del\/gremion-[a-z][a-z-]*(:|@|$)/

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
export const G9_SERVICES = ['ui', 'public', 'legal', 'vector', 'fallback']
const G9_BAD_COORDINATE = new RegExp(
  String.raw`(?:^|[\s(\`'"=|])(docker\.io/gremion/[a-z][a-z0-9._-]*|gremion/(?:${G9_SERVICES.join('|')})\b)`,
  'i'
)
const G9_IMAGE_LINE = /^\s*(?:#\s*)?image:\s*["']?([^\s"']+)/

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) walk(abs, out)
    else out.push(abs)
  }
  return out
}

/** Every file g9 reads under `root`, root-relative with forward slashes. */
export function g9Surfaces(root) {
  const out = []
  for (const dir of G9_SURFACE_DIRS) {
    if (!existsSync(join(root, dir))) continue
    out.push(...walk(join(root, dir)).map((f) => relative(root, f).replace(/\\/g, '/')))
  }
  out.push(...G9_SURFACE_FILES.filter((f) => existsSync(join(root, f))))
  return out.filter((f) => /\.(ya?ml|md)$/.test(f) || f === 'Makefile')
}

/** g9's verdict on `root`: null when clean, else the problem text. */
export function g9Check(root) {
  const surfaces = g9Surfaces(root)
  const problems = []
  const seenServices = new Set()
  for (const rel of surfaces) {
    readFileSync(join(root, rel), 'utf8')
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
}
