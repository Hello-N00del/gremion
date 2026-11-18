// The create flow for a customer whose board has a database of its own (the module declares
// runtime.database). Over recording fakes; the real enableModule's ordering and the real flag SQL are
// proven on a scratch server in test/integration/board-create.int.test.ts and in gremion-ui.
//
//  - the database server is asked BEFORE anything is written, in phase A (nothing exists yet) and
//    again in phase B before the administrators are invited;
//  - the location flag is written once the board's database exists, never before, and only on the
//    create path;
//  - a create without board, and a create while the catalogue's board entry declares no database, do
//    not touch the flag and do not ask the server.
import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPhaseA, createPhaseB, enableCustomerModule, loadModuleJsons, pgModules, recordHostStep, type CreateSpec, type ProvisioningDeps } from '../src/index.ts'
import { ADMINS, deps, DPIA, hostStamp, OPERATOR, TIP, world, type World } from './fakes.ts'

const SERVICE = 'board-postgres'

const spec = (over: Partial<CreateSpec> = {}): CreateSpec => {
  const enable = over.enable ?? ['board']
  return { slug: 'musterstadt', host: 'rat.musterstadt.example', enable, operatorId: OPERATOR, admins: ADMINS, dpia: Object.fromEntries(enable.map((m) => [m, DPIA])), ...over }
}

/** A world whose catalogue entry for board declares a database (the fixture the plan names; the real module.json is pinned below). */
function boardWorld(): World {
  const w = world()
  w.declared.set('board', SERVICE)
  w.isolation.set('board', { id: '01927f00-0000-7000-8000-00000000beef', passed: true, tip: TIP })
  return w
}

async function phaseA(w: World, d: ProvisioningDeps, s = spec()) {
  const a = await createPhaseA(s, d)
  if (!w.realms.get(a.customer.realm)?.smtp.user) hostStamp(w, a.customer)
  await recordHostStep(s.slug, 'mail_principal_issued', s.operatorId, d)
  return a
}

/** No module is ever recorded as enabled without its database (the one rule the create must keep at every point). */
function noEnabledWithoutDatabase(w: World, c: { id: string }, moduleId = 'board'): boolean {
  const enabled = w.enabled.get(c.id)?.has(moduleId) ?? false
  return !enabled || w.moduleDbs.has(`${c.id}/${moduleId}`)
}

describe('the board database server is asked before anything is written', () => {
  it('a create with board ticked and the server down is refused in phase A: no control row, no realm, no mutation of any kind', async () => {
    const w = boardWorld()
    w.serverAnswers.set(SERVICE, 0)
    await expect(createPhaseA(spec(), deps(w))).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringContaining(SERVICE) })
    expect(w.mutations).toEqual([])
    expect(w.control.size).toBe(0)
    expect(w.realms.size).toBe(0)
  })

  it('the refusal names no customer, host or address and says nothing was written', async () => {
    const w = boardWorld()
    w.serverAnswers.set(SERVICE, 0)
    const err = await createPhaseA(spec(), deps(w)).then(() => null, (e: Error) => e)
    expect(err?.message).toContain('nothing was written')
    expect(err?.message).not.toContain('musterstadt')
  })

  it('phase B asks again before the first account: a server that went away between the phases invites nobody', async () => {
    const w = boardWorld()
    const d = deps(w)
    const a = await phaseA(w, d)
    w.serverAnswers.set(SERVICE, 0)
    await expect(createPhaseB(spec(), d)).rejects.toMatchObject({ code: 'PRECONDITION' })
    expect(w.realms.get(a.customer.realm)?.users.size).toBe(0)
    expect(w.realms.get(a.customer.realm)?.mails).toEqual([])
    expect(w.enabled.get(a.customer.id)?.has('board') ?? false).toBe(false)
    expect(w.boardFlag.has(a.customer.id)).toBe(false)
  })

  it('a module that declares no database never asks a server (a down server elsewhere does not block a create without board)', async () => {
    const w = boardWorld()
    w.serverAnswers.set(SERVICE, 0)
    const d = deps(w)
    const s = spec({ enable: ['calendar'] })
    await phaseA(w, d, s)
    await expect(createPhaseB(s, d)).resolves.toMatchObject({ enabled: ['calendar'] })
  })

  it('a declared database with no way to ask the server fails closed instead of skipping the check', async () => {
    const w = boardWorld()
    const d = deps(w)
    delete (d.modules as { assertServerAnswers?: unknown }).assertServerAnswers
    await expect(createPhaseA(spec(), d)).rejects.toMatchObject({ code: 'PRECONDITION' })
    expect(w.mutations).toEqual([])
  })
})

describe('the create stops and resumes when the server fails after the pre-check', () => {
  it('no enabled enablement without a database at any point, no flag, and a rerun completes the create', async () => {
    const w = boardWorld()
    const d = deps(w)
    // phase A asks once; phase B asks once; the enable's own first query is refused
    w.serverAnswers.set(SERVICE, 2)
    const a = await phaseA(w, d)
    await expect(createPhaseB(spec(), d)).rejects.toThrow(/ECONNREFUSED/)
    expect(noEnabledWithoutDatabase(w, a.customer)).toBe(true)
    expect(w.enabled.get(a.customer.id)?.has('board') ?? false).toBe(false)
    expect(w.moduleDbs.size).toBe(0)
    expect(w.boardFlag.has(a.customer.id)).toBe(false)
    expect(w.control.get('musterstadt')?.status).toBe('provisioning')

    w.serverAnswers.delete(SERVICE) // the server is back
    const b = await createPhaseB(spec(), d)
    expect(b.enabled).toEqual(['board'])
    expect(noEnabledWithoutDatabase(w, a.customer)).toBe(true)
    expect(w.boardFlag.get(a.customer.id)).toBe('module')
    expect(w.control.get('musterstadt')?.status).toBe('active')
  })

  it('a crash between the enable and the flag leaves the customer provisioning; the rerun sets the flag', async () => {
    const w = boardWorld()
    const d = deps(w)
    const a = await phaseA(w, d)
    const real = d.boardLocation!.setModule
    let calls = 0
    d.boardLocation!.setModule = async (c) => {
      if (calls++ === 0) throw new Error('killed before the flag')
      return real(c)
    }
    await expect(createPhaseB(spec(), d)).rejects.toThrow(/killed before the flag/)
    expect(w.enabled.get(a.customer.id)?.has('board')).toBe(true)
    expect(w.boardFlag.has(a.customer.id)).toBe(false)
    expect(w.control.get('musterstadt')?.status).toBe('provisioning')
    await createPhaseB(spec(), d)
    expect(w.boardFlag.get(a.customer.id)).toBe('module')
  })
})

describe('the location flag', () => {
  it('is written after the board database exists and before the customer is activated', async () => {
    const w = boardWorld()
    const d = deps(w)
    const a = await phaseA(w, d)
    await createPhaseB(spec(), d)
    const at = (m: string) => w.mutations.indexOf(m)
    expect(at(`pg:create-module-db musterstadt/board`)).toBeGreaterThan(-1)
    expect(at(`pg:create-module-db musterstadt/board`)).toBeLessThan(at(`pg:enable musterstadt/board`))
    expect(at(`pg:enable musterstadt/board`)).toBeLessThan(at(`board:flag-module musterstadt`))
    expect(at(`board:flag-module musterstadt`)).toBeLessThan(at(`control:status musterstadt=active`))
    expect(w.boardFlag.get(a.customer.id)).toBe('module')
  })

  it('a rerun over a completed customer makes no mutating call (the flag is read first)', async () => {
    const w = boardWorld()
    const d = deps(w)
    await phaseA(w, d)
    await createPhaseB(spec(), d)
    const before = [...w.mutations]
    await createPhaseB(spec(), d)
    expect(w.mutations).toEqual(before)
  })

  it('a create without board never touches it and never asks the board server', async () => {
    const w = boardWorld()
    w.serverAnswers.set(SERVICE, 0)
    const d = deps(w)
    const a = await phaseA(w, d, spec({ enable: ['calendar', 'votes'] }))
    await createPhaseB(spec({ enable: ['calendar', 'votes'] }), d)
    expect(w.boardFlag.has(a.customer.id)).toBe(false)
    expect(w.mutations.some((m) => m.startsWith('board:'))).toBe(false)
    expect(w.moduleDbs.size).toBe(0)
  })

  it('board ticked while the catalogue declares no database: the board step does nothing and the server is never asked', async () => {
    const w = world() // nothing declared: the shape of today's module.json
    w.isolation.set('board', { id: '01927f00-0000-7000-8000-00000000beef', passed: true, tip: TIP })
    w.serverAnswers.set(SERVICE, 0)
    const d = deps(w)
    const a = await phaseA(w, d)
    const b = await createPhaseB(spec(), d)
    expect(b.enabled).toEqual(['board'])
    expect(w.boardFlag.has(a.customer.id)).toBe(false)
    expect(w.mutations.some((m) => m.startsWith('board:'))).toBe(false)
  })

  it('a declared database with no flag writer fails closed (the customer is not activated)', async () => {
    const w = boardWorld()
    const d = deps(w)
    await phaseA(w, d)
    delete (d as { boardLocation?: unknown }).boardLocation
    await expect(createPhaseB(spec(), d)).rejects.toMatchObject({ code: 'PRECONDITION' })
    expect(w.control.get('musterstadt')?.status).toBe('provisioning')
  })

  it('a later enable of board through the panel (enableCustomerModule) writes no flag: that path belongs to the lifecycle guard', async () => {
    const w = boardWorld()
    const d = deps(w)
    const s = spec({ enable: ['calendar'] })
    const a = await phaseA(w, d, s)
    await createPhaseB(s, d)
    await enableCustomerModule('musterstadt', 'board', { operatorId: OPERATOR, dpia: DPIA }, d)
    expect(w.enabled.get(a.customer.id)?.has('board')).toBe(true)
    expect(w.boardFlag.has(a.customer.id)).toBe(false)
  })
})

describe('the declaration is read from the catalogue, not assumed', () => {
  const MODULES = resolve(fileURLToPath(new URL('../../../', import.meta.url)), 'modules')
  const catalogue = loadModuleJsons(MODULES)
  const modules = pgModules({ platform: {} as never, catalogue, lifecycle: { server: () => ({}) as never, secrets: { appPassword: () => 'x' }, exporter: {} as never, exportDir: '/x', releaseRef: 'r' } })

  it('databaseService follows modules/board/module.json: its server when it declares a database, null when it declares none', () => {
    const declared = catalogue.find((m) => m.id === 'board')!.moduleJson.runtime.database
    expect(modules.databaseService?.('board') ?? null).toBe(declared?.postgresService ?? null)
  })

  it('every module that declares a database names it through the port, and the others name none', () => {
    for (const m of catalogue) expect(modules.databaseService?.(m.id) ?? null).toBe(m.moduleJson.runtime.database?.postgresService ?? null)
  })
})
