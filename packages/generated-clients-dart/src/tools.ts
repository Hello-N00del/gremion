// packages/generated-clients-dart/src/tools.ts
//
// How the two external tools are found and run. The shape follows
// packages/generated-clients/src/oasdiff-gate.ts: a PATH binary first, else a
// digest-pinned Docker image, but only when the daemon actually answers, and
// otherwise FAIL CLOSED. Every rule here prevents a silent success where the
// tool never ran:
//   - a PATH binary counts only if it reports the pinned version (another
//     version would produce different output, i.e. drift);
//   - an explicit $DART_BIN that is wrong fails. It never falls through to
//     another SDK the caller did not choose;
//   - a docker that is installed but has no reachable daemon is not a runner;
//   - the image must be present locally. Pulling is its own step
//     (`pnpm --filter @gremion/generated-clients-dart images:pull`), and runs
//     use `--pull never`;
//   - `docker run` exit codes 125/126/127 mean the engine did not run the
//     tool. That is reported as such, never as the tool's own verdict;
//   - any non-zero exit throws with the tool's output.
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { randomBytes } from 'node:crypto'
import { SCRATCH_ROOT } from './registry.ts'

// Pinned by INDEX digest (docker buildx imagetools inspect, 2026-09-25). Bump
// the tag and the digest together, then regenerate and commit the diff.
export const GENERATOR_VERSION = '7.12.0'
export const GENERATOR_IMAGE = 'openapitools/openapi-generator-cli:v7.12.0@sha256:338dc617d26fb4a515891dee8a5c345ad302e191c6010c6a1f77ed6f6ff7476a'
export const DART_SDK_VERSION = '3.11.5'
export const DART_IMAGE = 'dart:3.11.5@sha256:03b628160f6906098352a6d9c97a147afaa28cf4af97cb588aa33655d6ec3125'

/** Docker-side pub cache, persistent across runs, gitignored. */
export const DOCKER_PUB_CACHE = join(SCRATCH_ROOT, 'pub-cache')

const DART_PREFIX = ['--suppress-analytics']
const DOCKER_ENGINE_FAILURE = new Set([125, 126, 127])
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']

/** How a child process is started. Production uses spawnSync; the unit tests
 *  inject a spawn that runs their fake tools as Node scripts, so the
 *  fail-closed resolution rules are exercised on every OS (a `#!/bin/sh`
 *  fake cannot be spawned on Windows). */
export type SpawnFn = (cmd: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>
const defaultSpawn: SpawnFn = (cmd, args, options) => spawnSync(cmd, args, options)

export interface RunOpts {
  /** host directory mounted at /work in Docker; must sit under the repo */
  workDir: string
  /** working directory relative to workDir */
  cwd?: string
  /** false: no network at all (the generator never needs one) */
  network?: boolean
}

export interface Tool {
  /** which binary or image ran, for the log */
  describe: string
  /** kind of runner, for docker-specific pre-steps */
  kind: 'path' | 'docker'
  image?: string
  /** runs the tool, returns stdout+stderr; throws on any non-zero exit */
  run(args: string[], o: RunOpts): string
}

interface ResolveOpts {
  env?: NodeJS.ProcessEnv
  log?: (m: string) => void
  /** per-run wall clock limit; a hung pub get (proxy stall) or generator
   *  fails closed instead of blocking the check forever */
  timeoutMs?: number
  /** process starter; defaults to spawnSync (tests inject a fake) */
  spawn?: SpawnFn
}

export const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000

/** A run that was killed (timeout) or never started is not a verdict. */
function notRun(describe: string, r: SpawnSyncReturns<string>, timeoutMs: number): string | null {
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') return `${describe} timed out after ${timeoutMs} ms and was killed — it did not finish`
  if (r.error) return `${describe} did not run: ${r.error.message}`
  if (r.status === null) return `${describe} did not finish (killed by ${r.signal ?? 'a signal'})`
  return null
}

function probe(cmd: string, args: string[], env: NodeJS.ProcessEnv, spawn: SpawnFn = defaultSpawn): { ok: boolean; found: boolean; status: number | null; out: string } {
  const r = spawn(cmd, args, { encoding: 'utf8', env, timeout: 120_000 })
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, found: false, status: null, out: '' }
  return { ok: !r.error && r.status === 0, found: true, status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

export function dockerDaemonAvailable(env: NodeJS.ProcessEnv = process.env, spawn: SpawnFn = defaultSpawn): boolean {
  return probe('docker', ['version', '--format', '{{.Server.Version}}'], env, spawn).ok
}

function imagePresent(image: string, env: NodeJS.ProcessEnv, spawn: SpawnFn): boolean {
  return probe('docker', ['image', 'inspect', '--format', '{{.Id}}', image], env, spawn).ok
}

function failClosed(what: string, tried: string[]): Error {
  return new Error(
    `[generated-clients-dart] no usable ${what}: ${tried.join('; ')}. Failing closed. A tool that is `
    + 'missing, at another version, or behind an unreachable Docker daemon is not a result.',
  )
}

function pathTool(bin: string, describe: string, env: NodeJS.ProcessEnv, prefix: string[] = [], timeoutMs = DEFAULT_TIMEOUT_MS, spawn: SpawnFn = defaultSpawn): Tool {
  return {
    describe,
    kind: 'path',
    run(args, o) {
      const r = spawn(bin, [...prefix, ...args], { cwd: join(o.workDir, o.cwd ?? '.'), env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' })
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
      const why = notRun(describe, r, timeoutMs)
      if (why) throw new Error(`${why}\n${out}`)
      if (r.status !== 0) throw new Error(`${describe} ${args.join(' ')} exited ${r.status}:\n${out}`)
      return out
    },
  }
}

function loopbackProxy(env: NodeJS.ProcessEnv): boolean {
  return PROXY_VARS.slice(0, 4).some((k) => /^[a-z]+:\/\/(?:[^@/]*@)?(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(env[k] ?? ''))
}

function dockerTool(image: string, env: NodeJS.ProcessEnv, prefix: string[], extra: (o: RunOpts) => string[], timeoutMs = DEFAULT_TIMEOUT_MS, spawn: SpawnFn = defaultSpawn): Tool {
  const describe = `${image} (docker)`
  return {
    describe,
    kind: 'docker',
    image,
    run(args, o) {
      const name = `t124-gen-${process.pid}-${randomBytes(2).toString('hex')}`
      const cwd = ['/work', ...relative(o.workDir, join(o.workDir, o.cwd ?? '.')).split(/[\\/]/).filter(Boolean)].join('/')
      const user = typeof process.getuid === 'function' ? ['-u', `${process.getuid()}:${process.getgid?.() ?? 0}`] : []
      let net: string[] = ['--network', 'none']
      const passEnv: string[] = []
      if (o.network !== false) {
        net = loopbackProxy(env) ? ['--network', 'host'] : []
        // names only: values are read from this process's env by docker, never
        // put on a command line or into a log
        for (const k of PROXY_VARS) if (env[k]) passEnv.push('-e', k)
        const ca = env.SSL_CERT_FILE
        if (ca && existsSync(ca)) passEnv.push('-v', `${ca}:/etc/ssl/t124-extra-ca.crt:ro`, '-e', 'SSL_CERT_FILE=/etc/ssl/t124-extra-ca.crt')
      }
      const dockerArgs = ['run', '--rm', '--pull', 'never', '--name', name, ...user, ...net, ...passEnv,
        '-e', 'HOME=/tmp', '-v', `${o.workDir}:/work`, ...extra(o), '-w', cwd, image, ...prefix, ...args]
      try {
        const r = spawn('docker', dockerArgs, { env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' })
        const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
        const why = notRun(describe, r, timeoutMs) // the container itself is killed by the rm -f below
        if (why) throw new Error(`${why}\n${out}`)
        if (r.status === null || DOCKER_ENGINE_FAILURE.has(r.status)) {
          throw new Error(`${describe} did not run (docker exit ${r.status}: engine/daemon error, not a tool verdict):\n${out}`)
        }
        if (r.status !== 0) throw new Error(`${describe} ${args.join(' ')} exited ${r.status}:\n${out}`)
        return out
      } finally {
        spawn('docker', ['rm', '-f', name], { env, encoding: 'utf8' })
      }
    },
  }
}

function dockerFallback(image: string, env: NodeJS.ProcessEnv, tried: string[], what: string, spawn: SpawnFn): void {
  if (!dockerDaemonAvailable(env, spawn)) {
    tried.push('docker: not installed or the daemon does not answer')
    throw failClosed(what, tried)
  }
  if (!imagePresent(image, env, spawn)) {
    tried.push(`docker: pinned image ${image} is not present locally — run \`pnpm --filter @gremion/generated-clients-dart images:pull\` first`)
    throw failClosed(what, tried)
  }
}

/** openapi-generator at GENERATOR_VERSION on PATH (`openapi-generator-cli`,
 *  then `openapi-generator`), or null. `tried` collects why not. */
export function localGenerator(opts: ResolveOpts = {}, tried: string[] = []): Tool | null {
  const env = opts.env ?? process.env
  let seen = false
  for (const cand of ['openapi-generator-cli', 'openapi-generator']) {
    const p = probe(cand, ['version'], env, opts.spawn)
    if (!p.found) continue
    seen = true
    if (!p.ok) {
      tried.push(`PATH ${cand} found but \`${cand} version\` exited ${p.status ?? 'abnormally'}: ${p.out.split('\n')[0]}`)
      continue
    }
    const v = p.out.split('\n').pop()?.trim() ?? ''
    if (v === GENERATOR_VERSION) return pathTool(cand, `${cand} (PATH, version ${v})`, env, [], opts.timeoutMs, opts.spawn)
    tried.push(`PATH ${cand} reports version "${v}", pinned is ${GENERATOR_VERSION}`)
    opts.log?.(`ignoring ${cand} on PATH: version "${v}" is not the pinned ${GENERATOR_VERSION}`)
  }
  if (!seen) tried.push('no openapi-generator-cli / openapi-generator on PATH')
  return null
}

/** openapi-generator at GENERATOR_VERSION: PATH, else GENERATOR_IMAGE. */
export function resolveGenerator(opts: ResolveOpts = {}): Tool {
  const env = opts.env ?? process.env
  const tried: string[] = []
  const local = localGenerator(opts, tried)
  if (local) return local
  dockerFallback(GENERATOR_IMAGE, env, tried, `openapi-generator ${GENERATOR_VERSION}`, opts.spawn ?? defaultSpawn)
  return dockerTool(GENERATOR_IMAGE, env, [], () => [], opts.timeoutMs, opts.spawn)
}

function dartVersionOf(bin: string, env: NodeJS.ProcessEnv, spawn?: SpawnFn): string | null {
  const p = probe(bin, ['--version'], env, spawn)
  if (!p.ok) return null
  return /Dart SDK version: (\S+)/.exec(p.out)?.[1] ?? ''
}

/** Dart SDK at DART_SDK_VERSION from $DART_BIN or PATH, or null. A set but
 *  unusable $DART_BIN throws: an explicit choice never falls through. */
export function localDart(opts: ResolveOpts = {}, tried: string[] = []): Tool | null {
  const env = opts.env ?? process.env
  const explicit = env.DART_BIN
  if (explicit) {
    const v = existsSync(explicit) ? dartVersionOf(explicit, env, opts.spawn) : null
    if (v === DART_SDK_VERSION) return pathTool(explicit, `${explicit} ($DART_BIN, SDK ${v})`, env, DART_PREFIX, opts.timeoutMs, opts.spawn)
    throw failClosed(`Dart SDK ${DART_SDK_VERSION}`, [
      v === null ? `$DART_BIN (${explicit}) does not exist or does not run` : `$DART_BIN (${explicit}) is SDK "${v}", pinned is ${DART_SDK_VERSION}`,
    ])
  }
  const v = dartVersionOf('dart', env, opts.spawn)
  if (v === DART_SDK_VERSION) return pathTool('dart', `dart (PATH, SDK ${v})`, env, DART_PREFIX, opts.timeoutMs, opts.spawn)
  if (v === null) tried.push('no $DART_BIN, no dart on PATH')
  else {
    tried.push(`PATH dart is SDK "${v}", pinned is ${DART_SDK_VERSION}`)
    opts.log?.(`ignoring dart on PATH: SDK "${v}" is not the pinned ${DART_SDK_VERSION}`)
  }
  return null
}

/** Dart SDK at DART_SDK_VERSION: $DART_BIN, else PATH `dart`, else
 *  DART_IMAGE (with a persistent pub cache under .gen-work/). */
export function resolveDart(opts: ResolveOpts = {}): Tool {
  const env = opts.env ?? process.env
  const tried: string[] = []
  const local = localDart(opts, tried)
  if (local) return local
  dockerFallback(DART_IMAGE, env, tried, `Dart SDK ${DART_SDK_VERSION}`, opts.spawn ?? defaultSpawn)
  return dockerTool(DART_IMAGE, env, ['dart', ...DART_PREFIX], () => {
    mkdirSync(DOCKER_PUB_CACHE, { recursive: true }) // else docker creates it root-owned
    return ['-v', `${DOCKER_PUB_CACHE}:/pub-cache`, '-e', 'PUB_CACHE=/pub-cache']
  }, opts.timeoutMs, opts.spawn)
}
