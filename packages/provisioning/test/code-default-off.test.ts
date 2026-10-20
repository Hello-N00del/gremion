// TASK-058 (A): the code default of the provisioning path is every module off
// (TRD-030, TRD-064; operator decision R31-I4a G9). A create request that names
// no module enables none; a request that names a module enables that one and
// nothing else. The pilot's votes come from its create request, never from a
// default in this package.
//
// Watched failing on a seeded wrong default first: a `validateCreate` that falls
// back to ['votes'] for an empty list fails the two "names no module" cases; an
// `assertEnableList` that falls back to ['elections'] fails three of the five.
import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertEnableList, createPhaseA, createPhaseB, recordHostStep, validateCreate, type CreateSpec } from '../src/index.ts'
import { ADMINS, deps, hostStamp, OPERATOR, UNDECIDED_MODULE, world } from './fakes.ts'

/** Every module directory of the kernel tree: the set a default could wrongly switch on. */
function treeModuleIds(): string[] {
  const dir = new URL('../../../modules/', import.meta.url)
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

const spec = (over: Partial<CreateSpec> = {}): CreateSpec => ({
  slug: 'rat-ohne-module',
  host: 'rat.ohne-module.example',
  enable: [],
  operatorId: OPERATOR,
  admins: ADMINS,
  ...over,
})

async function createAll(s: CreateSpec, catalogue: string[]) {
  const w = world()
  const d = deps(w, catalogue)
  const a = await createPhaseA(s, d)
  hostStamp(w, a.customer)
  await recordHostStep(s.slug, 'mail_principal_issued', s.operatorId, d)
  const b = await createPhaseB(s, d)
  return { w, a, b }
}

describe('provisioning code default: every module off (TRD-030, TRD-064, R31-I4a G9)', () => {
  it('the tree names the modules the guard covers (elections, votes, finance, board and vault among them)', () => {
    const ids = treeModuleIds()
    for (const id of ['elections', 'votes', 'finance', 'board', 'vault']) expect(ids).toContain(id)
  })

  it('validateCreate returns an empty enable list for a request that names no module, over the whole tree catalogue', () => {
    const catalogue = [...treeModuleIds(), UNDECIDED_MODULE]
    expect(validateCreate(spec({ enable: [] }), catalogue).enable).toEqual([])
  })

  it('assertEnableList returns [] for [] whatever the catalogue holds', () => {
    expect(assertEnableList([], [])).toEqual([])
    expect(assertEnableList([], treeModuleIds())).toEqual([])
  })

  it('a create request that names no module enables none: no enable, no attestation, a kernel-only broker, an empty level-2 list', async () => {
    const s = spec()
    const { w, a, b } = await createAll(s, [...treeModuleIds(), UNDECIDED_MODULE])
    expect(b.enabled).toEqual([])
    expect(w.enabled.get(a.customer.id)?.size ?? 0).toBe(0)
    expect(w.mutations.filter((m) => m.startsWith('pg:enable '))).toEqual([])
    expect(w.mutations.filter((m) => m.startsWith('plt:attest '))).toEqual([])
    expect(w.config.get(s.slug)).toEqual({ modules: [], setupComplete: true })
    expect(w.broker.get(s.slug)).toEqual(['kernel'])
    expect(w.control.get(s.slug)?.status).toBe('active')
  })

  it('a request that names votes only enables votes: elections, finance, board and vault stay off', async () => {
    const s = spec({ slug: 'rat-mit-abstimmungen', host: 'rat.mit-abstimmungen.example', enable: ['votes'] })
    const { w, a, b } = await createAll(s, [...treeModuleIds(), UNDECIDED_MODULE])
    expect(b.enabled).toEqual(['votes'])
    const enabled = [...(w.enabled.get(a.customer.id)?.keys() ?? [])]
    expect(enabled).toEqual(['votes'])
    for (const off of ['elections', 'finance', 'board', 'vault']) expect(enabled).not.toContain(off)
    expect(w.mutations.filter((m) => m.startsWith('pg:enable '))).toEqual([`pg:enable ${s.slug}/votes`])
  })
})
