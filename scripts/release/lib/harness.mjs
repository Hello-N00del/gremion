// Test harness for the TASK-046 supply-chain suites: a digest-pinned local
// registry on 127.0.0.1:<free port>, throwaway cosign keys, tiny images.
//
// House rules this file enforces (brief §9):
//   - every container and volume is named t046-<run8>-<role>, where <run8> is
//     8 random hex per test process (node --test runs files in parallel, so a
//     name derived from HEAD alone would collide between two files);
//   - teardown is `docker rm -f <names>` / `docker volume rm <names>` only —
//     never compose down, never prune;
//   - keys are EPHEMERAL: generated with an empty password into the gitignored
//     scripts/release/.t046-tmp/<run8>/ and deleted in teardown. Nothing a
//     test generates is ever committed.
//
// Missing docker is a FAIL, not a skip: requireDocker() throws.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'

import { IMAGES } from './tools.mjs'

export const RELEASE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = join(RELEASE_DIR, '..', '..')

export function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
}

export function requireDocker() {
  const r = sh('docker', ['info', '--format', '{{.ServerVersion}}'])
  if (r.status !== 0) throw new Error(`docker daemon not reachable (FAIL, not skip): ${r.stderr}`)
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

export class Harness {
  constructor(role = 'x') {
    this.run8 = randomBytes(4).toString('hex')
    this.prefix = `t046-${this.run8}`
    this.role = role
    this.tmp = join(RELEASE_DIR, '.t046-tmp', this.run8)
    this.containers = []
    this.volumes = []
    mkdirSync(this.tmp, { recursive: true })
  }

  name(suffix) {
    return `${this.prefix}-${suffix}`
  }

  async startRegistry() {
    requireDocker()
    this.port = await freePort()
    const name = this.name('reg')
    const r = sh('docker', [
      'run', '-d', '--rm', '--name', name,
      '-p', `127.0.0.1:${this.port}:5000`,
      IMAGES.registry,
    ])
    if (r.status !== 0) throw new Error(`registry did not start: ${r.stderr}`)
    this.containers.push(name)
    this.registry = `127.0.0.1:${this.port}`
    // Post-condition, not the exit code: the API answers.
    for (let i = 0; i < 50; i++) {
      const c = sh('curl', ['-fsS', '--noproxy', '*', `http://${this.registry}/v2/`])
      if (c.status === 0) return this.registry
      await new Promise((res) => setTimeout(res, 200))
    }
    throw new Error(`registry ${name} never answered on ${this.registry}`)
  }

  stopRegistry() {
    sh('docker', ['rm', '-f', this.name('reg')])
  }

  /**
   * Builds a FROM-scratch image carrying `files` ({relPath: content}), pushes
   * it as <registry>/hello-n00del/<repo>:<tag>, returns the digest reference.
   */
  pushImage(repo, tag, files) {
    const ctx = join(this.tmp, `ctx-${repo}-${tag}-${randomBytes(3).toString('hex')}`)
    mkdirSync(ctx, { recursive: true })
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(ctx, 'root', rel)), { recursive: true })
      writeFileSync(join(ctx, 'root', rel), content)
    }
    writeFileSync(join(ctx, 'Dockerfile'), 'FROM scratch\nCOPY root/ /\n')
    const ref = `${this.registry}/hello-n00del/${repo}:${tag}`
    let r = sh('docker', ['build', '-q', '--provenance=false', '--sbom=false', '-t', ref, ctx])
    if (r.status !== 0) throw new Error(`build ${ref}: ${r.stderr}`)
    r = sh('docker', ['push', '-q', ref])
    if (r.status !== 0) throw new Error(`push ${ref}: ${r.stderr}`)
    // The registry's own answer is the digest of record, not the local store's.
    const h = sh('curl', [
      '-fsSI', '--noproxy', '*',
      '-H', 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
      `http://${this.registry}/v2/hello-n00del/${repo}/manifests/${tag}`,
    ])
    const m = /docker-content-digest:\s*(sha256:[0-9a-f]{64})/i.exec(h.stdout)
    if (!m) throw new Error(`no digest for ${ref}: ${h.stdout}${h.stderr}`)
    sh('docker', ['image', 'rm', '-f', ref])
    return `${this.registry}/hello-n00del/${repo}@${m[1]}`
  }

  /** An ephemeral cosign key pair (empty password). Returns {key, pub}. */
  keyPair(label) {
    const dir = join(this.tmp, `keys-${label}`)
    mkdirSync(dir, { recursive: true })
    const r = sh('cosign', ['generate-key-pair', '--output-key-prefix', join(dir, 'cosign')], {
      env: { ...process.env, COSIGN_PASSWORD: '' },
    })
    if (r.status !== 0) throw new Error(`cosign generate-key-pair: ${r.stderr}`)
    return { key: join(dir, 'cosign.key'), pub: join(dir, 'cosign.pub') }
  }

  sign(ref, key) {
    const r = sh('cosign', ['sign', '--key', key, '--tlog-upload=false', '--yes', ref], {
      env: { ...process.env, COSIGN_PASSWORD: '' },
    })
    if (r.status !== 0) throw new Error(`cosign sign ${ref}: ${r.stderr}`)
    return r
  }

  attest(ref, key, predicatePath) {
    const r = sh(
      'cosign',
      ['attest', '--key', key, '--type', 'cyclonedx', '--predicate', predicatePath, '--tlog-upload=false', '--yes', ref],
      { env: { ...process.env, COSIGN_PASSWORD: '' } },
    )
    if (r.status !== 0) throw new Error(`cosign attest ${ref}: ${r.stderr}`)
    return r
  }

  copyTree(src, rel) {
    const dst = join(this.tmp, rel)
    cpSync(src, dst, { recursive: true })
    return dst
  }

  teardown() {
    if (this.containers.length) sh('docker', ['rm', '-f', ...this.containers])
    if (this.volumes.length) sh('docker', ['volume', 'rm', ...this.volumes])
    rmSync(this.tmp, { recursive: true, force: true })
  }
}

export function gitHead(cwd = REPO_ROOT) {
  return execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}
