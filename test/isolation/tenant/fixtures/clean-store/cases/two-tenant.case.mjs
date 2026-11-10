import { createStore } from '../store.mjs'

describe('fixture store: two-tenant isolation', () => {
  it('positive control: A reads its own row', () => {
    const s = createStore()
    s.put('A', 'canary-a')
    expect(s.list('A')).toContain('canary-a')
  })

  it("B's rows are not readable as A", () => {
    const s = createStore()
    s.put('A', 'canary-a')
    s.put('B', 'canary-b')
    expect(s.list('A')).not.toContain('canary-b')
  })
})
