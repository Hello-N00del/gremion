// The pinned supply-chain tool set (TASK-046, TRD-441/443).
//
// Every container is pinned by DIGEST, never by tag: a tag can be re-pushed,
// a digest cannot. The version in the comment is informational; the digest is
// the pin. The images are pulled through mirror.gcr.io (Google's public Docker
// Hub cache) because anonymous Docker Hub pulls are rate-limited; the digest
// is content-addressed, so the mirror cannot substitute other bytes.
//
// cosign is the one tool that is NOT a container: the deploy host runs it as a
// binary (gremion-deploy calls `cosign verify`), and the workstation signs with
// the same binary. It is pinned by version AND by the sha256 of the release
// asset, and assertCosign() refuses any other binary. Missing = FAIL, never a
// skip (brief §5).

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

export const IMAGES = Object.freeze({
  // registry v2.8.x (distribution) — local test registry only
  registry:
    'mirror.gcr.io/library/registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373',
  // syft v1.33.0
  syft: 'mirror.gcr.io/anchore/syft@sha256:f94e5d9fce1f2278491a8e3a63bd5f6ddb81fdfdbb8bf7a1637565c1d5344357',
  // grype v0.100.0
  grype:
    'mirror.gcr.io/anchore/grype@sha256:dcf0168c9b275c6dbcbff5ceeecfac29a6ccf138a87f0adc9ce5bd69fe6146f3',
})

// cosign v2.6.5, linux-amd64 release asset, sha256 from the release's
// cosign_checksums.txt. v2 is pinned deliberately: its key-based flow takes
// `--tlog-upload=false` (sign/attest) and `--insecure-ignore-tlog=true`
// (verify) and never contacts Rekor; v3 changed the signing-config defaults.
export const COSIGN = Object.freeze({
  version: 'v2.6.5',
  sha256: 'c3b4f5410e608af03a5eb0aaac84a4313d8da131248e08ff1759ac70c79d1644',
  asset: 'https://github.com/sigstore/cosign/releases/download/v2.6.5/cosign-linux-amd64',
})

export const DIGEST_REF_RE = /^[a-z0-9][a-z0-9.:_/-]*@sha256:[0-9a-f]{64}$/

/** Absolute path of the cosign on PATH, or null. */
export function whichCosign(env = process.env) {
  try {
    return execFileSync('bash', ['-c', 'command -v cosign'], { env, encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

/**
 * Throws unless `cosign` on PATH is byte-identical to the pinned release asset.
 * Returns the path. A different build of the "same" version is refused too.
 */
export function assertCosign(env = process.env) {
  const p = whichCosign(env)
  if (!p) throw new Error(`cosign not on PATH — install ${COSIGN.version} (${COSIGN.asset}), sha256 ${COSIGN.sha256}`)
  const got = createHash('sha256').update(readFileSync(p)).digest('hex')
  if (got !== COSIGN.sha256) {
    throw new Error(`cosign at ${p} is not the pinned ${COSIGN.version} build: sha256 ${got}, want ${COSIGN.sha256}`)
  }
  return p
}
