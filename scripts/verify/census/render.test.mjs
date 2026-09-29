// TASK-036 TDD item 6: render arguments. Docker is injected everywhere except
// the one test that proves a repo-level `.env` and a parent COMPOSE_* env
// cannot reach a real `docker compose config`.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { run } from '../lib/proc.mjs'
import { ALLOWANCES, childEnv, parseExemptList, PINS_FILES, planRender, PROJECTS, readEnvKey, RENDER_ENV, renderProject, REPO_ROOT } from './render.mjs'

const FIXTURES = path.join(import.meta.dirname, '__fixtures__')
const byName = (n) => PROJECTS.find((p) => p.name === n)

function fakeTemplate(lines) {
  return () => lines.join('\n')
}

test('readEnvKey finds a key wherever it sits and refuses a duplicate', () => {
  const text = '# COMPOSE_FILE=commented.yml\nA=1\n\nCOMPOSE_FILE=a.yml:b.yml\n'
  assert.equal(readEnvKey(text, 'COMPOSE_FILE'), 'a.yml:b.yml')
  assert.equal(readEnvKey(text, 'MISSING'), null)
  assert.throws(() => readEnvKey('K=1\nK=2\n', 'K'), /declared 2 times/)
  assert.deepEqual(parseExemptList(' a  b '), ['a', 'b'])
  assert.deepEqual(parseExemptList(''), [])
})

test('the state plan passes -f per listed file, never the dev override, plus --env-file and --project-directory', () => {
  const plan = planRender(byName('state'), {
    root: '/r',
    exists: () => true,
    readText: fakeTemplate(['COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml:docker-compose.pins.yml', 'COMPOSE_PROFILES=production', 'HEALTH_EXEMPT_SERVICES=job-a job-b']),
  })
  assert.deepEqual(plan.errors, [])
  const argv = plan.argv
  const fIdx = argv.flatMap((a, i) => (a === '-f' ? [i + 1] : []))
  assert.deepEqual(fIdx.map((i) => path.basename(argv[i])), ['docker-compose.yml', 'docker-compose.prod.yml'])
  assert.ok(!argv.some((a) => a.includes('override')), 'the dev override must never be passed')
  assert.equal(argv[argv.indexOf('--env-file') + 1], RENDER_ENV)
  assert.equal(argv[argv.indexOf('--project-directory') + 1], path.resolve('/r', '.'))
  assert.deepEqual(argv.slice(-3), ['config', '--format', 'json'])
  assert.equal(argv[argv.indexOf('--profile') + 1], 'production')
  assert.ok(plan.notes.some((n) => n.startsWith('pins: not censused')), plan.notes.join('\n'))
  assert.deepEqual(plan.exempt, ['job-a', 'job-b'])
})

test('TASK-048b: the state plan with docker-compose.state-pins.yml notes "pins: not censused" and never passes it', () => {
  const plan = planRender(byName('state'), {
    root: '/r',
    exists: (p) => !p.endsWith('docker-compose.state-pins.yml'),
    readText: fakeTemplate(['COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml:docker-compose.state-pins.yml', 'COMPOSE_PROFILES=production']),
  })
  assert.deepEqual(plan.errors, [])
  assert.ok(plan.notes.includes('pins: not censused (state: docker-compose.state-pins.yml)'), plan.notes.join('\n'))
  assert.ok(!plan.argv.some((a) => a.includes('pins')), plan.argv.join(' '))
  assert.deepEqual([...PINS_FILES].sort(), ['docker-compose.pins.yml', 'docker-compose.state-pins.yml'])
})

test('mail and ops render from their own project directories', () => {
  for (const [name, dir] of [['mail', 'infra/host/mail'], ['ops', 'infra/host/ops']]) {
    const plan = planRender(byName(name), { root: '/r', exists: () => true, readText: fakeTemplate(['COMPOSE_FILE=docker-compose.yml', 'COMPOSE_PROFILES=x']) })
    assert.equal(plan.argv[plan.argv.indexOf('--project-directory') + 1], path.resolve('/r', dir))
    assert.equal(plan.argv[plan.argv.indexOf('-f') + 1], path.join(path.resolve('/r', dir), 'docker-compose.yml'))
  }
})

test('a listed compose file that is missing fails the plan; the pins file does not', () => {
  const plan = planRender(byName('state'), {
    root: '/r',
    exists: (p) => !p.endsWith('docker-compose.prod.yml') && !PINS_FILES.some((f) => p.endsWith(f)),
    readText: fakeTemplate(['COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml:docker-compose.pins.yml', 'COMPOSE_PROFILES=production']),
  })
  assert.equal(plan.argv, null)
  assert.equal(plan.errors.length, 1)
  assert.match(plan.errors[0], /docker-compose\.prod\.yml, which does not exist/)
})

test('a template without COMPOSE_FILE, or with only the pins file, is an error', () => {
  assert.match(planRender(byName('state'), { root: '/r', exists: () => true, readText: fakeTemplate(['X=1']) }).errors[0], /no COMPOSE_FILE/)
  assert.match(
    planRender(byName('state'), { root: '/r', exists: () => true, readText: fakeTemplate(['COMPOSE_FILE=docker-compose.pins.yml']) }).errors[0],
    /no compose file left/,
  )
})

test('a dated allowance holds only while its file is absent, and fails once it exists', () => {
  const tmpl = fakeTemplate(['COMPOSE_FILE=docker-compose.app.yml:docker-compose.pins.yml', 'COMPOSE_PROFILES=production'])
  const allowances = [{ project: 'app', file: 'docker-compose.app.yml', dated: '2026-09-27', removedBy: 'TASK-040', why: 'fixture' }]
  const absent = planRender(byName('app'), { root: '/r', allowances, exists: () => false, readText: tmpl })
  assert.equal(absent.allowed, true)
  assert.deepEqual(absent.errors, [])
  assert.ok(absent.notes.some((n) => /dated allowance 2026-09-27, removed by TASK-040/.test(n)), absent.notes.join('\n'))
  const present = planRender(byName('app'), { root: '/r', allowances, exists: () => true, readText: tmpl })
  assert.match(present.errors.join('\n'), /stale allowance: docker-compose\.app\.yml now exists/)
  // No allowance at all: absent is simply a failure.
  const strict = planRender(byName('app'), { root: '/r', allowances: [], exists: () => false, readText: tmpl })
  assert.match(strict.errors.join('\n'), /docker-compose\.app\.yml, which does not exist/)
})

test('TASK-040 retired the app allowance: none is shipped and the real app project plans a render', () => {
  assert.deepEqual(ALLOWANCES, [])
  const plan = planRender(byName('app'))
  assert.deepEqual(plan.errors, [])
  assert.equal(plan.allowed, false)
  assert.ok(plan.argv, 'the app project must produce a render argv')
  assert.ok(plan.files.some((f) => path.basename(f) === 'docker-compose.app.yml'), plan.files.join('\n'))
})

test('childEnv drops COMPOSE_* and interpolated names, keeps the OS/docker ones', () => {
  const env = childEnv({ COMPOSE_FILE: 'x', COMPOSE_PROFILES: 'dev', COMPOSE_PROJECT_NAME: 'p', DOMAIN: 'leak', STALWART_IMAGE: 'evil', Path: 'C:/bin', SystemRoot: 'C:/Windows', DOCKER_HOST: 'npipe:////./pipe/x' })
  assert.deepEqual(Object.keys(env).sort(), ['DOCKER_HOST', 'Path', 'SystemRoot'])
})

test('a parent COMPOSE_PROFILES=dev leaves the argv unchanged and never reaches docker', () => {
  const tmpl = fakeTemplate(['COMPOSE_FILE=docker-compose.yml', 'COMPOSE_PROFILES=production'])
  const before = planRender(byName('ops'), { root: '/r', exists: () => true, readText: tmpl }).argv
  const saved = process.env.COMPOSE_PROFILES
  process.env.COMPOSE_PROFILES = 'dev'
  try {
    const plan = planRender(byName('ops'), { root: '/r', exists: () => true, readText: tmpl })
    assert.deepEqual(plan.argv, before)
    let seenEnv
    const res = renderProject(plan, {
      docker: (_cmd, _args, opts) => {
        seenEnv = opts.env
        return { code: 0, stdout: '{"services":{"a":{}}}', stderr: '', error: null }
      },
      env: childEnv(),
    })
    assert.equal(res.ok, true)
    assert.equal(seenEnv.COMPOSE_PROFILES, undefined)
  } finally {
    if (saved === undefined) delete process.env.COMPOSE_PROFILES
    else process.env.COMPOSE_PROFILES = saved
  }
})

test('renderProject: a non-zero exit, empty stdout, or a document without services is a failed render', () => {
  const plan = { project: 'p', dir: '/r', errors: [], allowed: false, argv: ['compose'] }
  const fake = (code, stdout) => () => ({ code, stdout, stderr: 'boom', error: null })
  assert.equal(renderProject(plan, { docker: fake(1, '{"services":{"a":{}}}') }).ok, false)
  assert.equal(renderProject(plan, { docker: fake(0, '') }).ok, false)
  assert.equal(renderProject(plan, { docker: fake(0, '{"name":"x"}') }).ok, false)
  assert.equal(renderProject(plan, { docker: () => ({ code: null, stdout: '', stderr: '', error: { code: 'ENOENT' } }) }).toolMissing, 'docker')
  const empty = renderProject(plan, { docker: fake(0, '{"services":{}}') })
  assert.equal(empty.ok, true)
  assert.deepEqual(empty.services, {})
})

test('a real render ignores a project-level .env and the parent COMPOSE_* / interpolated env (docker)', () => {
  const dir = path.join(FIXTURES, 'env-leak')
  const dotenv = path.join(dir, '.env')
  writeFileSync(dotenv, 'LEAK_TAG=from-dotenv\nCOMPOSE_PROFILES=dev\n')
  const saved = { ...process.env }
  process.env.COMPOSE_PROFILES = 'dev'
  process.env.COMPOSE_FILE = 'nope.yml'
  process.env.LEAK_TAG = 'from-parent'
  try {
    const project = { name: 'leak', template: 'leak.env.tmpl', dir: '.' }
    const plan = planRender(project, { root: dir, renderEnv: path.join(dir, 'render.env'), allowances: [] })
    assert.deepEqual(plan.errors, [])
    const res = renderProject(plan, { docker: run, env: childEnv() })
    assert.equal(res.ok, true, res.detail)
    assert.deepEqual(Object.keys(res.services).sort(), ['always'])
    assert.equal(res.services.always.image, 'busybox:from-render-env')
  } finally {
    rmSync(dotenv, { force: true })
    for (const k of ['COMPOSE_PROFILES', 'COMPOSE_FILE', 'LEAK_TAG']) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
})

test('every *_IMAGE key in render.env equals the same key in its env template', () => {
  const renderEnv = readFileSync(RENDER_ENV, 'utf8')
  const keys = renderEnv.split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+_IMAGE)=/)?.[1]).filter(Boolean)
  assert.ok(keys.length > 0, 'render.env declares no *_IMAGE key (STALWART_IMAGE expected)')
  for (const key of keys) {
    const owners = PROJECTS.map((p) => readEnvKey(readFileSync(path.join(REPO_ROOT, p.template), 'utf8'), key)).filter((v) => v !== null)
    assert.equal(owners.length, 1, `${key} must be declared by exactly one env template`)
    assert.equal(readEnvKey(renderEnv, key), owners[0], `${key} drifted between render.env and its template`)
  }
  assert.ok(existsSync(path.join(REPO_ROOT, 'infra/host/templates/env/state.env.tmpl')))
})
