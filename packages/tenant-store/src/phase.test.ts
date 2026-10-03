// TASK-075 TDD 6 (no database half): a file's phase is its header, else the
// baseline map (whose file must still hash to the lock), else PHASE_MISSING.
import { describe, expect, it } from 'vitest'
import { baselinePhaseFor, compareReleases, headerPhase, parseHeader, PhaseError, releaseVersion, resolvePhase, sha256Text } from './phase.js'

const LEGACY = 'CREATE TABLE a (id int);\n'
const baseline = { chains: { c: { '001_a.sql': 'expand' as const, '002_b.sql': 'contract' as const } } }
const lock = { chains: { c: { files: { '001_a.sql': sha256Text(LEGACY), '002_b.sql': sha256Text('DROP TABLE a;\n') } } } }
const phaseFor = baselinePhaseFor('c', baseline, lock)
const code = (f: () => unknown) => {
  try {
    f()
  } catch (e) {
    return (e as PhaseError).code
  }
  return 'no error'
}

describe('phase header', () => {
  it('reads expand, migrate and contract with its contract-after', () => {
    expect(headerPhase('x', '-- gremion:phase expand\nSELECT 1;')).toEqual({ phase: 'expand' })
    expect(headerPhase('x', '-- gremion:phase migrate\r\nSELECT 1;')).toEqual({ phase: 'migrate' })
    expect(headerPhase('x', '-- gremion:phase contract\n-- note\n-- gremion:contract-after dist-v2.0.1\nDROP TABLE a;')).toEqual({ phase: 'contract', contractAfter: 'dist-v2.0.1' })
  })

  it('a contract without contract-after, a misplaced or malformed marker, is refused', () => {
    expect(code(() => headerPhase('x', '-- gremion:phase contract\nDROP TABLE a;'))).toBe('CONTRACT_AFTER_MISSING')
    expect(code(() => headerPhase('x', '-- x\n-- gremion:phase expand\n'))).toBe('PHASE_MALFORMED')
    expect(code(() => headerPhase('x', '-- gremion:phase contract\n-- gremion:contract-after v2\n'))).toBe('PHASE_MALFORMED')
    expect(parseHeader('-- gremion:phase expand\n-- gremion:manual-dump upgrade.md step 3\nSELECT 1;').manualDump).toBe('upgrade.md step 3')
  })
})

describe('resolvePhase', () => {
  it('the header wins over the baseline', () => {
    expect(resolvePhase('001_a.sql', `-- gremion:phase migrate\n${LEGACY}`, () => ({ phase: 'expand' }))).toEqual({ phase: 'migrate' })
  })

  it('a headerless locked file gets its baseline phase; a baseline contract waits for dist-v0.0.0', () => {
    expect(resolvePhase('001_a.sql', LEGACY, phaseFor)).toEqual({ phase: 'expand' })
    expect(resolvePhase('002_b.sql', 'DROP TABLE a;\n', phaseFor)).toEqual({ phase: 'contract', contractAfter: 'dist-v0.0.0' })
  })

  it('neither header nor baseline entry is PHASE_MISSING', () => {
    expect(code(() => resolvePhase('003_c.sql', LEGACY, phaseFor))).toBe('PHASE_MISSING')
    expect(code(() => resolvePhase('003_c.sql', LEGACY))).toBe('PHASE_MISSING')
  })

  it('a baseline file whose bytes changed is LOCKED_FILE_CHANGED, never re-hashed', () => {
    expect(code(() => resolvePhase('001_a.sql', `${LEGACY}-- edited\n`, phaseFor))).toBe('LOCKED_FILE_CHANGED')
  })
})

describe('release order', () => {
  it('compares dist-vX.Y.Z numerically and rejects what is not a release', () => {
    expect(compareReleases('dist-v1.10.0', 'dist-v1.9.9')).toBeGreaterThan(0)
    expect(compareReleases('dist-v1.2.3', '1.2.3')).toBe(0)
    expect(releaseVersion('import-job-1')).toBeNull()
    expect(() => compareReleases('dist-v1', 'dist-v1.0.0')).toThrow(/not a release/)
  })
})
