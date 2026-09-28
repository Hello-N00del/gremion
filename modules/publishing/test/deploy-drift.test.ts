/**
 * Compose ↔ k8s drift test — Task 18 (P1 newsletter leaf, #201)
 *
 * Asserts that the k8s manifests for nats, newsletter-postgres, and
 * newsletter-service stay in sync with docker-compose.yml.  Three axes:
 *   1. Image tag matches (compose vs k8s StatefulSet / Deployment)
 *   2. Env-var KEY NAMES are equal (compose env block vs k8s configmap + secret stubs)
 *   3. Readiness probe HTTP path+port match (HTTP-based services only)
 *
 * Run:  pnpm -C services/newsletter test -- deploy-drift
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

// ── Resolve paths ──────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../../')
const COMPOSE_FILE = path.join(REPO_ROOT, 'docker-compose.yml')
const K8S_BASE = path.join(REPO_ROOT, 'k8s', 'base')

// ── Helpers ────────────────────────────────────────────────────────────────

type AnyObject = Record<string, unknown>

function readYaml(filePath: string): AnyObject {
  const raw = fs.readFileSync(filePath, 'utf-8')
  return parseYaml(raw) as AnyObject
}

/** Parse a multi-document YAML file (separated by ---) and return all docs. */
function readYamlAll(filePath: string): AnyObject[] {
  const raw = fs.readFileSync(filePath, 'utf-8')
  const chunks = raw.split(/^---$/m)
  return chunks
    .map(c => c.trim())
    .filter(Boolean)
    .map(c => parseYaml(c) as AnyObject)
    .filter(Boolean)
}

/** Read all *.yaml files in a directory (non-recursive), returning parsed docs. */
function readDirYaml(dir: string): AnyObject[] {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.yaml'))
  return files.flatMap(f => {
    const docs = readYamlAll(path.join(dir, f))
    return docs
  })
}

/** Find a k8s manifest by kind + metadata.name across a list of docs. */
function findManifest(docs: AnyObject[], kind: string, name: string): AnyObject | undefined {
  return docs.find(
    d => (d as AnyObject).kind === kind && ((d as AnyObject).metadata as AnyObject)?.name === name,
  )
}

/** Collect env KEY names from a k8s container spec via direct env[] entries. */
function containerEnvKeys(container: AnyObject): Set<string> {
  const keys = new Set<string>()
  const envArr = container.env as Array<{ name: string }> | undefined
  if (Array.isArray(envArr)) {
    for (const e of envArr) {
      if (e.name) keys.add(e.name)
    }
  }
  return keys
}

/** Collect all top-level data keys from a ConfigMap or Secret manifest. */
function manifestDataKeys(doc: AnyObject): Set<string> {
  const keys = new Set<string>()
  const data = (doc.data ?? doc.stringData) as Record<string, unknown> | undefined
  if (data) {
    for (const k of Object.keys(data)) keys.add(k)
  }
  return keys
}

/**
 * Collect ALL env key names visible to a container, resolving envFrom
 * references by looking up ConfigMap and Secret manifests in allDocs.
 */
function resolveEnvKeys(container: AnyObject, allDocs: AnyObject[]): Set<string> {
  const keys = new Set<string>()

  // Direct env[] entries
  for (const k of containerEnvKeys(container)) keys.add(k)

  // envFrom: configMapRef + secretRef
  const envFrom = container.envFrom as Array<{
    configMapRef?: { name: string }
    secretRef?: { name: string }
  }> | undefined
  if (Array.isArray(envFrom)) {
    for (const src of envFrom) {
      const refName = src.configMapRef?.name ?? src.secretRef?.name
      if (!refName) continue
      // Look for a ConfigMap or Secret with that name in allDocs
      const cm = allDocs.find(d => {
        const meta = d.metadata as AnyObject | undefined
        return (d.kind === 'ConfigMap' || d.kind === 'Secret') && meta?.name === refName
      })
      if (cm) {
        for (const k of manifestDataKeys(cm)) keys.add(k)
      }
    }
  }

  return keys
}

/** Extract the first container spec from a Deployment or StatefulSet. */
function firstContainer(workload: AnyObject): AnyObject {
  const podSpec = ((workload.spec as AnyObject).template as AnyObject).spec as AnyObject
  const containers = podSpec.containers as AnyObject[]
  return containers[0]
}

/** Compose env block → set of key names. */
function composeEnvKeys(serviceSpec: AnyObject): Set<string> {
  const keys = new Set<string>()
  const env = serviceSpec.environment as Record<string, unknown> | undefined
  if (env) {
    for (const k of Object.keys(env)) keys.add(k)
  }
  return keys
}

/**
 * Assert symmetric difference between two sets is empty (minus allowed side-sets).
 * allowComposeOnly: keys that legitimately exist ONLY in compose (not a k8s gap).
 * allowK8sOnly:    keys that legitimately exist ONLY in k8s (compose doesn't need them).
 */
function assertEnvParity(
  label: string,
  composeKeys: Set<string>,
  k8sKeys: Set<string>,
  allowComposeOnly: string[] = [],
  allowK8sOnly: string[] = [],
): void {
  const composeSet = new Set([...composeKeys].filter(k => !allowComposeOnly.includes(k)))
  const k8sSet = new Set([...k8sKeys].filter(k => !allowK8sOnly.includes(k)))

  const missingFromK8s = [...composeSet].filter(k => !k8sSet.has(k))
  const missingFromCompose = [...k8sSet].filter(k => !composeSet.has(k))

  if (missingFromK8s.length > 0 || missingFromCompose.length > 0) {
    throw new Error(
      `[${label}] Env key drift detected.\n` +
        (missingFromK8s.length > 0
          ? `  Missing from k8s: ${missingFromK8s.join(', ')}\n`
          : '') +
        (missingFromCompose.length > 0
          ? `  Missing from compose: ${missingFromCompose.join(', ')}\n`
          : ''),
    )
  }
}

// ── Parse sources once ─────────────────────────────────────────────────────

const composeDoc = readYaml(COMPOSE_FILE)
const services = (composeDoc.services as Record<string, AnyObject>)

const natsService = services['nats']
const nlPostgresService = services['newsletter-postgres']
const nlService = services['newsletter-service']

const natsDir = path.join(K8S_BASE, 'nats')
const newsletterDir = path.join(K8S_BASE, 'newsletter')

// ── NATS ───────────────────────────────────────────────────────────────────

describe('NATS — compose ↔ k8s drift', () => {
  it('k8s/base/nats/ directory exists and is parseable', () => {
    expect(fs.existsSync(natsDir), `${natsDir} does not exist`).toBe(true)
    const docs = readDirYaml(natsDir)
    expect(docs.length, 'expected at least 1 k8s manifest in nats/').toBeGreaterThan(0)
  })

  it('NATS StatefulSet image matches compose', () => {
    const natsDocs = readDirYaml(natsDir)
    const ss = findManifest(natsDocs, 'StatefulSet', 'nats')
    expect(ss, 'StatefulSet nats not found in k8s/base/nats/').toBeDefined()
    const k8sImage = firstContainer(ss!).image as string
    const composeImage = natsService.image as string
    expect(k8sImage).toBe(composeImage)
  })

  it('NATS has no env keys in compose and k8s (NATS uses CLI flags only)', () => {
    const natsDocs = readDirYaml(natsDir)
    const ss = findManifest(natsDocs, 'StatefulSet', 'nats')
    expect(ss).toBeDefined()
    const k8sEnvKeys = resolveEnvKeys(firstContainer(ss!), natsDocs)
    const composeNatsEnvKeys = composeEnvKeys(natsService)
    // NATS has no env vars in either compose or k8s — just verify parity
    assertEnvParity('nats', composeNatsEnvKeys, k8sEnvKeys)
  })

  it('NATS readiness probe is HTTP GET /healthz on port 8222 (matches compose healthcheck)', () => {
    const natsDocs = readDirYaml(natsDir)
    const ss = findManifest(natsDocs, 'StatefulSet', 'nats')
    expect(ss).toBeDefined()
    const container = firstContainer(ss!)
    const probe = container.readinessProbe as AnyObject | undefined
    expect(probe, 'readinessProbe missing from nats container').toBeDefined()
    const httpGet = probe!.httpGet as AnyObject | undefined
    expect(httpGet, 'readinessProbe.httpGet missing (NATS healthcheck is HTTP)').toBeDefined()
    expect(httpGet!.path).toBe('/healthz')
    expect(httpGet!.port).toBe(8222)
  })
})

// ── newsletter-postgres ────────────────────────────────────────────────────

describe('newsletter-postgres — compose ↔ k8s drift', () => {
  it('k8s/base/newsletter/ directory exists and is parseable', () => {
    expect(fs.existsSync(newsletterDir), `${newsletterDir} does not exist`).toBe(true)
    const docs = readDirYaml(newsletterDir)
    expect(docs.length, 'expected at least 1 k8s manifest in newsletter/').toBeGreaterThan(0)
  })

  it('newsletter-postgres StatefulSet image matches compose', () => {
    const nlDocs = readDirYaml(newsletterDir)
    const ss = findManifest(nlDocs, 'StatefulSet', 'newsletter-postgres')
    expect(ss, 'StatefulSet newsletter-postgres not found in k8s/base/newsletter/').toBeDefined()
    const k8sImage = firstContainer(ss!).image as string
    const composeImage = nlPostgresService.image as string
    expect(k8sImage).toBe(composeImage)
  })

  it('newsletter-postgres env key names match compose (via postgres-secret stub)', () => {
    const nlDocs = readDirYaml(newsletterDir)
    const ss = findManifest(nlDocs, 'StatefulSet', 'newsletter-postgres')
    expect(ss).toBeDefined()
    const k8sEnvKeys = resolveEnvKeys(firstContainer(ss!), nlDocs)
    const composeNlPgEnvKeys = composeEnvKeys(nlPostgresService)
    // No allowlist needed — both sides expose the same 3 PG keys
    assertEnvParity('newsletter-postgres', composeNlPgEnvKeys, k8sEnvKeys)
  })

  it('newsletter-postgres has a readinessProbe (exec pg_isready, not HTTP)', () => {
    const nlDocs = readDirYaml(newsletterDir)
    const ss = findManifest(nlDocs, 'StatefulSet', 'newsletter-postgres')
    expect(ss).toBeDefined()
    const probe = (firstContainer(ss!).readinessProbe) as AnyObject | undefined
    expect(probe, 'readinessProbe missing from newsletter-postgres container').toBeDefined()
    // Must be exec (not HTTP) — pg_isready
    expect(probe!.exec, 'expected exec probe for newsletter-postgres (pg_isready)').toBeDefined()
  })
})

// ── newsletter-service ─────────────────────────────────────────────────────

describe('newsletter-service — compose ↔ k8s drift', () => {
  it('newsletter-service Deployment image matches compose (strip registry prefix if any)', () => {
    const nlDocs = readDirYaml(newsletterDir)
    const dep = findManifest(nlDocs, 'Deployment', 'newsletter-service')
    expect(dep, 'Deployment newsletter-service not found in k8s/base/newsletter/').toBeDefined()
    const k8sImage = firstContainer(dep!).image as string
    const composeImage = nlService.image as string
    // Strip any registry prefix (e.g. "registry.example.com/") for comparison
    const stripPrefix = (img: string) => img.replace(/^[^/]+\.[^/]+\//, '')
    const splitTag = (img: string) => {
      const i = img.lastIndexOf(':')
      return i === -1 ? { repo: img, tag: '' } : { repo: img.slice(0, i), tag: img.slice(i + 1) }
    }

    const k8s = splitTag(stripPrefix(k8sImage))
    const compose = splitTag(stripPrefix(composeImage))

    // The REPOSITORY must never drift — k8s pointing at a different image than
    // compose is the actual failure this test exists to catch.
    expect(k8s.repo).toBe(compose.repo)

    // The TAG is allowed to diverge in exactly one direction (#431): k8s/base
    // deliberately carries the digest-pin sentinel so an overlay is forced to
    // supply an immutable tag, rather than floating on compose's mutable
    // `:latest`. Any OTHER divergence is real drift and still fails.
    const DIGEST_PIN_SENTINEL = 'OVERLAY_MUST_PROVIDE_DIGEST_PINNED_TAG'
    if (k8s.tag !== DIGEST_PIN_SENTINEL) {
      expect(k8s.tag).toBe(compose.tag)
    }
  })

  it('newsletter-service env key names match compose (configmap + secret stubs, no allowlist needed)', () => {
    /*
     * COMPOSE_ONLY_ALLOWLIST: none.
     *
     * All compose env keys are explicitly present in k8s:
     *   PORT, SCHEDULER_ENABLED, NATS_URL, KERNEL_BASE_URL, TRACE_EXPORTER
     *     → newsletter-config ConfigMap
     *   NEWSLETTER_PG_URL, INTERNAL_NEWSLETTER_SECRET
     *     → newsletter-secret stub (base-level sentinel; overlay overrides with real value)
     *
     * Note on NEWSLETTER_PG_URL: compose assembles the full DSN via shell
     * interpolation.  In k8s we store the assembled DSN as a secret key with
     * the SAME NAME so the application code sees an identical env var name.
     * This avoids any code divergence between compose and k8s runtimes.
     */
    const nlDocs = readDirYaml(newsletterDir)
    const dep = findManifest(nlDocs, 'Deployment', 'newsletter-service')
    expect(dep).toBeDefined()
    const k8sEnvKeys = resolveEnvKeys(firstContainer(dep!), nlDocs)
    const composeNlEnvKeys = composeEnvKeys(nlService)
    assertEnvParity('newsletter-service', composeNlEnvKeys, k8sEnvKeys)
  })

  it('newsletter-service readiness probe is HTTP GET /healthz on port 8080', () => {
    const nlDocs = readDirYaml(newsletterDir)
    const dep = findManifest(nlDocs, 'Deployment', 'newsletter-service')
    expect(dep).toBeDefined()
    const container = firstContainer(dep!)
    const probe = container.readinessProbe as AnyObject | undefined
    expect(probe, 'readinessProbe missing from newsletter-service container').toBeDefined()
    const httpGet = probe!.httpGet as AnyObject | undefined
    expect(httpGet, 'readinessProbe.httpGet missing (newsletter-service healthcheck is HTTP)').toBeDefined()
    expect(httpGet!.path).toBe('/healthz')
    expect(httpGet!.port).toBe(8080)
  })
})
