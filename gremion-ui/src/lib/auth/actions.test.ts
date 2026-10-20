import { describe, test, expect } from 'vitest'
import { ACTIONS, getActionPolicy } from './actions'

describe('action registry', () => {
  test('the kernel registry holds only the actions of the module halves the tree carries', () => {
    // Feature modules register their step-up-gated actions here when present
    // (TASK-205c: vault.secret.reveal; finance joins with its half, TASK-205d).
    expect(Object.keys(ACTIONS)).toEqual(['vault.secret.reveal'])
    expect(getActionPolicy('vault.secret.reveal')).toMatchObject({ module: 'vault', anyCapability: [], requiredLoa: 2 })
  })

  test('getActionPolicy + ActionPolicy plumbing remains exported', () => {
    expect(typeof getActionPolicy).toBe('function')
  })
})
