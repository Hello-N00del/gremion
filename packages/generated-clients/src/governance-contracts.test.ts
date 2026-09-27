// packages/generated-clients/src/governance-contracts.test.ts
//
// TASK-083 (brief §6 TDD table, T1-T9), scoped to the two governance
// documents this unit adds: contracts/governance/openapi.gov.json and
// contracts/governance/asyncapi.gov.json. RED because: before this
// commit neither file, nor their registry entries, nor the generated
// client existed — see round-2 verifier CRITICAL finding (branch was
// byte-identical to release-1/local-integration).
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateOpenApiDoc, validateAsyncApiDoc, collectUnresolvedRefs } from './schema.js'
import { validateRegistry } from './registry.js'
import { checkOpenApiCompat } from './oasdiff-gate.js'
import { REPO_ROOT } from './repo-root.js'

const OPENAPI_PATH = 'contracts/governance/openapi.gov.json'
const ASYNCAPI_PATH = 'contracts/governance/asyncapi.gov.json'
const PKG_DIR = join(REPO_ROOT, 'packages', 'generated-clients')

function loadOpenApi(): any {
  return JSON.parse(readFileSync(join(REPO_ROOT, OPENAPI_PATH), 'utf8'))
}
function loadAsyncApi(): any {
  return JSON.parse(readFileSync(join(REPO_ROOT, ASYNCAPI_PATH), 'utf8'))
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const

function allOperations(doc: any): Array<{ path: string; method: string; op: any }> {
  const ops: Array<{ path: string; method: string; op: any }> = []
  for (const [p, item] of Object.entries<any>(doc.paths)) {
    for (const m of HTTP_METHODS) {
      if (item[m]) ops.push({ path: p, method: m, op: item[m] })
    }
  }
  return ops
}

describe('T1 — both governance specs are registered and pass structure + $ref closure', () => {
  it('are registered in contracts/registry.json (governance-http, governance-lifecycle)', () => {
    const { problems, entries } = validateRegistry(REPO_ROOT)
    expect(problems).toEqual([])
    const names = entries.map((e) => e.name)
    expect(names).toContain('governance-http')
    expect(names).toContain('governance-lifecycle')
    const http = entries.find((e) => e.name === 'governance-http')!
    const lifecycle = entries.find((e) => e.name === 'governance-lifecycle')!
    expect(http.file).toBe(OPENAPI_PATH)
    expect(http.type).toBe('openapi')
    expect(lifecycle.file).toBe(ASYNCAPI_PATH)
    expect(lifecycle.type).toBe('asyncapi')
  })

  it('openapi.gov.json is structurally valid OpenAPI 3.1 with no unresolved $ref', () => {
    const doc = loadOpenApi()
    expect(validateOpenApiDoc(doc)).toEqual([])
    expect(collectUnresolvedRefs(doc)).toEqual([])
    expect(doc.openapi).toMatch(/^3\.1\./)
    expect(doc.info.version).toBe('1.0.0')
  })

  it('asyncapi.gov.json is structurally valid AsyncAPI 3.0 with no unresolved $ref', () => {
    const doc = loadAsyncApi()
    expect(validateAsyncApiDoc(doc)).toEqual([])
    expect(collectUnresolvedRefs(doc)).toEqual([])
    expect(doc.asyncapi).toBe('3.0.0')
    expect(doc.info.version).toBe('1.0.0')
  })
})

describe('T2 — every operation has an operationId and named ($ref) schemas', () => {
  it('every OpenAPI operation declares a unique operationId', () => {
    const doc = loadOpenApi()
    const ops = allOperations(doc)
    expect(ops.length).toBeGreaterThan(0)
    const ids = ops.map(({ op }) => op.operationId)
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length) // no duplicates
  })

  it('every request body and non-array 2xx response body is a named $ref, not an inline schema', () => {
    const doc = loadOpenApi()
    for (const { path, method, op } of allOperations(doc)) {
      const reqSchema = op.requestBody?.content?.['application/json']?.schema
      const reqSchemaOk = !reqSchema || Boolean(reqSchema.$ref)
      expect(reqSchemaOk, `${method} ${path} requestBody`).toBe(true)
      for (const [status, resp] of Object.entries<any>(op.responses)) {
        if (!status.startsWith('2')) continue
        const schema = resp.content?.['application/json']?.schema
        if (!schema) continue
        const target = schema.type === 'array' ? schema.items : schema
        expect(target.$ref, `${method} ${path} ${status} response`).toBeDefined()
      }
    }
  })

  it('every $ref used by an operation names a schema present in components.schemas', () => {
    const doc = loadOpenApi()
    const schemaNames = new Set(Object.keys(doc.components.schemas))
    let checked = 0
    for (const { op } of allOperations(doc)) {
      const reqRef = op.requestBody?.content?.['application/json']?.schema?.$ref
      if (!reqRef) continue
      expect(schemaNames.has(reqRef.replace('#/components/schemas/', ''))).toBe(true)
      checked++
    }
    // A guard that checked zero operations "passes" without checking anything.
    expect(checked).toBeGreaterThan(0)
  })
})

describe('T3 — inventory: the 6 resource families exist under /api/v1, and nothing from P3', () => {
  it('has at least one route for each of meetings, agenda-sections, agenda-items, invitations, motions, and their sub-resources', () => {
    const doc = loadOpenApi()
    const paths = Object.keys(doc.paths)
    const families = ['/api/v1/meetings', '/api/v1/agenda-sections', '/api/v1/agenda-items', '/api/v1/invitations', '/api/v1/motions']
    for (const family of families) {
      expect(paths.some((p) => p.startsWith(family)), `no route under ${family}`).toBe(true)
    }
    expect(paths.some((p) => /notice-override/.test(p))).toBe(true)
    expect(paths.some((p) => /recipients/.test(p))).toBe(true)
    expect(paths.some((p) => /admissions/.test(p))).toBe(true)
  })

  it('carries no P3-additive resource (protocol, resolution, register, poll)', () => {
    const doc = loadOpenApi()
    const paths = Object.keys(doc.paths).join('\n')
    for (const p3 of ['protocol', 'resolution', 'register', 'poll']) {
      expect(paths).not.toMatch(new RegExp(p3, 'i'))
    }
    const async = loadAsyncApi()
    const channels = Object.keys(async.channels).join('\n')
    for (const p3 of ['protocol', 'resolution', 'register', 'poll']) {
      expect(channels).not.toMatch(new RegExp(p3, 'i'))
    }
  })
})

describe('T4 — notice-override: POST only, reason required, no mutating verbs; send declares 409', () => {
  it('the notice-override path item declares only POST (no PUT/PATCH/DELETE)', () => {
    const doc = loadOpenApi()
    const item = doc.paths['/api/v1/invitations/{invitationId}/notice-override']
    expect(item).toBeDefined()
    expect(item.post).toBeDefined()
    for (const m of ['put', 'patch', 'delete'] as const) expect(item[m]).toBeUndefined()
  })

  it('NoticeOverrideCreate requires "reason"', () => {
    const doc = loadOpenApi()
    const schema = doc.components.schemas.NoticeOverrideCreate
    expect(schema.required).toContain('reason')
    expect(schema.properties.reason.minLength).toBeGreaterThanOrEqual(1)
  })

  it('the send operation declares a 409 response', () => {
    const doc = loadOpenApi()
    const send = doc.paths['/api/v1/invitations/{invitationId}/send'].post
    expect(send.responses['409']).toBeDefined()
  })
})

describe('T5 — motion: is_late readOnly; admission outcome enum and a defer target', () => {
  it('Motion.is_late is readOnly and is never in MotionCreate', () => {
    const doc = loadOpenApi()
    const motion = doc.components.schemas.Motion
    expect(motion.properties.is_late.readOnly).toBe(true)
    const motionCreate = doc.components.schemas.MotionCreate
    expect(motionCreate.properties.is_late).toBeUndefined()
  })

  it('MotionAdmission(Create) has an admit|defer outcome enum and a nullable defer target', () => {
    const doc = loadOpenApi()
    for (const name of ['MotionAdmission', 'MotionAdmissionCreate']) {
      const schema = doc.components.schemas[name]
      expect(schema.properties.outcome.enum.sort()).toEqual(['admit', 'defer'])
    }
    expect(doc.components.schemas.MotionAdmission.properties.deferred_to_meeting_id).toBeDefined()
  })
})

function envelopePayloadProps(async: any, schemaKey: string): Record<string, unknown> {
  const schema = async.components.schemas[schemaKey]
  // allOf[EventEnvelope, {properties:{payload:{allOf:[{properties:{...}}]}}}]
  const payloadWrapper = schema.allOf[1].properties.payload
  return payloadWrapper.allOf[0].properties
}

describe('T6 — event payloads match DOMAIN field-for-field; minimisation asserted', () => {
  it('meeting.scheduled has neither title nor location', () => {
    const async = loadAsyncApi()
    const props = envelopePayloadProps(async, 'EnvelopeMeetingScheduled')
    expect(props.title).toBeUndefined()
    expect(props.location).toBeUndefined()
    expect(Object.keys(props).sort()).toEqual(
      ['aggregate_version', 'body_id', 'meeting_id', 'org_unit_id', 'scheduled_end', 'scheduled_start'].sort(),
    )
  })

  it('notice.overridden has no free-text reason property', () => {
    const async = loadAsyncApi()
    const props = envelopePayloadProps(async, 'EnvelopeNoticeOverridden')
    expect(props.reason).toBeUndefined()
    expect(Object.keys(props)).not.toContain('reason')
  })

  it('carries exactly the 11 DOMAIN governance messages, one per event', () => {
    const async = loadAsyncApi()
    expect(Object.keys(async.components.messages).length).toBe(11)
  })
})

describe('T7 — InvitationRecipient schema has no address/email property', () => {
  it('exposes delivery_state but never an address or e-mail', () => {
    const doc = loadOpenApi()
    const schema = doc.components.schemas.InvitationRecipient
    expect(schema.properties.delivery_state).toBeDefined()
    for (const forbidden of ['address', 'email', 'e_mail']) {
      expect(schema.properties[forbidden]).toBeUndefined()
    }
  })
})

// Time budget (R26-FLAKES, R27 scope). T8 spawns `npx tsc` / `npm pack`, T9
// spawns oasdiff. Measured 2026-09-28 on the 16-CPU dev box, "loaded" = 32
// CPU-spinning + 4 file-I/O node processes on top of the other agents on the
// box (idle = 5 isolated whole-package runs, loaded = pooled loaded runs):
//
//   T8 tsc typecheck (node-/browser-style)   idle p95 3.5 s (n=10)   loaded p95 58.9 s (n=12, p50 37.3 s)
//   T8 npm pack --dry-run                    idle p95 2.0 s (n=5)    loaded p95 80.8 s (n=5, p50 67.7 s)
//   T9 checkOpenApiCompat (oasdiff)          idle p95 0.4 s (n=10)   loaded p95 10.8 s (n=10)
//
// The old flat 120 s was under 3x the loaded p95 for T8, and T9 ran on the
// 5 s default. Each budget is 3x its loaded p95, rounded up. No global raise.
const TSC_FIXTURE_MS = 180_000
const NPM_PACK_DRY_RUN_MS = 245_000
const OASDIFF_DEMO_MS = 35_000

describe('T8 — consumer fixture typechecks both import shapes', () => {
  it('the node-style fixture (relative deep import, nodenext resolution) typechecks clean', () => {
    const out = runTsc('tsconfig.consumer-node.json')
    expect(out.trim()).toBe('')
  }, TSC_FIXTURE_MS)

  it('the browser-style fixture (package-subpath import, bundler resolution) typechecks clean', () => {
    const out = runTsc('tsconfig.consumer-browser.json')
    expect(out.trim()).toBe('')
  }, TSC_FIXTURE_MS)

  it('the browser-style import resolves through the package export map, not a paths shim', () => {
    // package self-reference: bundler resolution reads package.json
    // "exports"./governance-client, exactly as a linked consumer would
    const cfg = JSON.parse(readFileSync(join(PKG_DIR, 'tsconfig.consumer-browser.json'), 'utf8'))
    expect(cfg.compilerOptions?.paths).toBeUndefined()
    expect(cfg.compilerOptions?.baseUrl).toBeUndefined()
    expect(cfg.compilerOptions?.moduleResolution ?? 'bundler').toBe('bundler')
    // only the fixture is the input; the client must be reached via the import
    expect(cfg.include).toEqual(['src/consumer-fixture/browser-style.ts'])
  })

  it('the consumer fixtures are not compiled into the published dist', () => {
    const build = JSON.parse(readFileSync(join(PKG_DIR, 'tsconfig.build.json'), 'utf8'))
    expect(build.exclude).toContain('src/consumer-fixture/**')
  })

  it('the consumer fixtures are not shipped in the npm tarball either (files ships src/)', () => {
    // the real post-condition: ask npm what it would pack, not the manifest
    const args = ['pack', '--dry-run', '--json', '--ignore-scripts']
    const out = execFileSync(
      process.platform === 'win32' ? 'cmd' : 'npm',
      process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', ...args] : args,
      { cwd: PKG_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const packed: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path)
    // vacuity guard: the tarball does carry the generated client from src/
    expect(packed).toContain('src/generated/governance-client.ts')
    expect(packed.filter((p) => p.startsWith('src/consumer-fixture/'))).toEqual([])
  }, NPM_PACK_DRY_RUN_MS)
})

describe('T9 — breaking demo: a required response field removed is RED at 1.0.0, GREEN at 2.0.0', () => {
  const FIXTURE_DIR = join(REPO_ROOT, 'contracts', 'governance', 'fixtures')
  const base = readFileSync(join(FIXTURE_DIR, 'base-1.0.0.json'), 'utf8')
  const removedSameVersion = readFileSync(join(FIXTURE_DIR, 'state-removed-1.0.0.json'), 'utf8')
  const removedBumped = readFileSync(join(FIXTURE_DIR, 'state-removed-2.0.0.json'), 'utf8')

  it('removing Meeting.state at the SAME version (1.0.0 -> 1.0.0) is RED, naming the field', () => {
    const result = checkOpenApiCompat(base, removedSameVersion)
    expect(result.ok).toBe(false)
    expect(result.breaking).toBe(true)
    expect(result.reason).toMatch(/state/)
  }, OASDIFF_DEMO_MS)

  it('the same removal with a MAJOR bump (1.0.0 -> 2.0.0) is GREEN', () => {
    const result = checkOpenApiCompat(base, removedBumped)
    expect(result.ok).toBe(true)
    expect(result.bump).toBe('major')
  }, OASDIFF_DEMO_MS)
})

function runTsc(configFile: string): string {
  try {
    return execFileSync(
      process.platform === 'win32' ? 'cmd' : 'npx',
      process.platform === 'win32'
        ? ['/d', '/s', '/c', 'npx', 'tsc', '--noEmit', '-p', configFile]
        : ['tsc', '--noEmit', '-p', configFile],
      { cwd: PKG_DIR, encoding: 'utf8' },
    )
  } catch (e: any) {
    // tsc writes errors to stdout, not stderr, and exits non-zero — surface
    // that output as the test failure message rather than just "exit 1".
    throw new Error(`tsc -p ${configFile} failed:\n${e.stdout ?? e.message}`)
  }
}
