// TASK-041 (L3-08): render the proof edge's Traefik configuration.
//
//   node test/host/fixtures/tenant-host-proof/render-traefik.mjs <out-dir>
//
// Env: T041_SHA8, T041_PROXY_SECRET, T041_PROOF_PORT (container side).
//
// STATIC: the production docker/traefik/traefik.yml, its @MARKERS@ substituted
// the way the compose `traefik` command does, plus ONE plaintext entrypoint
// `proof` whose forwardedHeaders.trustedIPs is COPIED from `websecure` -- so
// the proof's trust boundary is production's, not a looser one. The edge
// subnets render as the RFC 5737 / RFC 3849 documentation ranges: like today's
// composition (TASK-022 residual, traefik.yml:77-81) they match no real peer, so
// the only trusted peer is the container's own loopback -- which is exactly
// where proof (c) sends its forged X-Forwarded-Host from.
//
// DYNAMIC: dynamic.yml.tmpl with the per-run names and the proxy-trust secret.
// The secret is generated per run by the script and is never committed.
//
// Prints `T041-TRUSTED websecure=<json> proof=<json>` for the script to compare.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..', '..')
const out = process.argv[2]
if (!out) throw new Error('usage: render-traefik.mjs <out-dir>')
const need = (k) => {
  const v = process.env[k]
  if (!v) throw new Error(`${k} is required`)
  return v
}
const sha8 = need('T041_SHA8')
const secret = need('T041_PROXY_SECRET')
const proofPort = need('T041_PROOF_PORT')

// The same substitution the compose `traefik` service performs at start-up.
const staticSrc = readFileSync(path.join(repo, 'docker', 'traefik', 'traefik.yml'), 'utf8')
  .replaceAll('@ACME_EMAIL@', 'proof@t041.test')
  .replaceAll('@ACME_CA_SERVER@', 'https://acme.t041.test/directory')
  .replaceAll('@EDGE_V4_SUBNET@', '192.0.2.0/24')
  .replaceAll('@EDGE_V6_SUBNET@', '2001:db8::/32')
if (/@[A-Z0-9_]+@/.test(staticSrc)) throw new Error('an @MARKER@ was left unrendered in traefik.yml')
const cfg = parse(staticSrc)
const trusted = cfg?.entryPoints?.websecure?.forwardedHeaders?.trustedIPs
if (!Array.isArray(trusted) || trusted.length === 0) throw new Error('websecure has no trustedIPs to copy')
cfg.entryPoints.proof = {
  address: `:${proofPort}`,
  forwardedHeaders: { trustedIPs: [...trusted] },
}
// The docker provider stays as rendered: with no socket proxy on the proof
// network it registers nothing (and says so in the Traefik log); every router
// of the proof is file-provided.

const dynamicSrc = readFileSync(path.join(here, 'dynamic.yml.tmpl'), 'utf8')
  .replaceAll('@SHA8@', sha8)
  .replaceAll('@PROXY_SECRET@', secret)
if (/@[A-Z0-9_]+@/.test(dynamicSrc)) throw new Error('an @MARKER@ was left unrendered in dynamic.yml.tmpl')
parse(dynamicSrc) // must be valid YAML

mkdirSync(path.join(out, 'dynamic'), { recursive: true })
writeFileSync(path.join(out, 'traefik.yml'), stringify(cfg))
writeFileSync(path.join(out, 'dynamic', 'proof.yml'), dynamicSrc)

// Read the RENDERED file back: the comparison is of what Traefik will load.
const rendered = parse(readFileSync(path.join(out, 'traefik.yml'), 'utf8'))
console.log(
  `T041-TRUSTED websecure=${JSON.stringify(rendered.entryPoints.websecure.forwardedHeaders.trustedIPs)} ` +
    `proof=${JSON.stringify(rendered.entryPoints.proof.forwardedHeaders.trustedIPs)}`,
)
