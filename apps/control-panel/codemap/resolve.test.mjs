// resolve.mjs: the text is joined to the graph by file and function NAME, never by line number.
import { describe, expect, it } from 'vitest'
import { resolve } from './resolve.mjs'

const fn = (file, name, line) => ({ id: `fn:${file}#${name}@${line}`, kind: 'function', name, file, line })
const area = (id) => ({ id, kind: 'area', name: id })
const page = (id) => ({ id, kind: 'page', name: id })
const graph = (nodes) => ({ meta: {}, nodes, edges: [] })
const step = (file, name, text = `text of ${name}`) => ({ text, file, function: name })
const text = (walkthroughs, areas = {}) => ({ walkthroughs, areas })

describe('resolve: steps', () => {
  it('matches a function by file and name after its line moved', () => {
    const g = graph([fn('a/b.ts', 'load', 120)])
    const r = resolve(g, text([{ title: 'W', steps: [step('a/b.ts', 'load')] }]))
    expect(r.staleSteps).toEqual([])
    expect(r.walkthroughs).toHaveLength(1)
    expect(r.walkthroughs[0].steps).toEqual([{ text: 'text of load', id: 'fn:a/b.ts#load@120' }])
    expect(r.walkthroughs[0].stale).toEqual([])
  })

  it('a renamed function is a stale step with its walkthrough, position, file, function and text', () => {
    const g = graph([fn('a/b.ts', 'loadAll', 10), fn('a/b.ts', 'other', 20)])
    const r = resolve(g, text([{ title: 'W', steps: [step('a/b.ts', 'other'), step('a/b.ts', 'load', 'old text')] }]))
    expect(r.staleSteps).toEqual([{ walkthrough: 'W', step: 2, file: 'a/b.ts', function: 'load', text: 'old text' }])
    expect(r.walkthroughs[0].steps).toHaveLength(1)
    expect(r.walkthroughs[0].stale).toEqual([{ step: 2, name: 'load', text: 'old text' }])
  })

  it('the same name in another file does not match', () => {
    const g = graph([fn('x.ts', 'load', 1)])
    const r = resolve(g, text([{ title: 'W', steps: [step('a/b.ts', 'load')] }]))
    expect(r.staleSteps).toHaveLength(1)
  })

  it('only a function node matches a file and function step', () => {
    const g = graph([{ id: 'file:a/b.ts', kind: 'file', name: 'load', file: 'a/b.ts', line: 0 }])
    expect(resolve(g, text([{ title: 'W', steps: [step('a/b.ts', 'load')] }])).staleSteps).toHaveLength(1)
  })

  it('several matches: the lowest line wins and the step is listed as ambiguous', () => {
    const g = graph([fn('a/b.ts', 'handle', 90), fn('a/b.ts', 'handle', 12), fn('a/b.ts', 'handle', 55)])
    const r = resolve(g, text([{ title: 'W', steps: [step('a/b.ts', 'handle')] }]))
    expect(r.walkthroughs[0].steps[0].id).toBe('fn:a/b.ts#handle@12')
    expect(r.ambiguousSteps).toEqual([{ walkthrough: 'W', step: 1, file: 'a/b.ts', function: 'handle', matches: 3, line: 12 }])
    expect(r.staleSteps).toEqual([])
  })

  it('a nodeId step matches by exact id', () => {
    const g = graph([page('page:p/+page.svelte')])
    const r = resolve(g, text([{ title: 'W', steps: [{ text: 'T', nodeId: 'page:p/+page.svelte' }, { text: 'U', nodeId: 'page:gone/+page.svelte' }] }]))
    expect(r.walkthroughs[0].steps).toEqual([{ text: 'T', id: 'page:p/+page.svelte' }])
    expect(r.staleSteps).toEqual([{ walkthrough: 'W', step: 2, nodeId: 'page:gone/+page.svelte', text: 'U' }])
    expect(r.walkthroughs[0].stale[0].name).toBe('gone/+page.svelte')
  })

  it('the step position counts the written order, so a stale step in the middle keeps its number', () => {
    const g = graph([fn('a.ts', 'one', 1), fn('a.ts', 'three', 3)])
    const r = resolve(g, text([{ title: 'W', steps: [step('a.ts', 'one'), step('a.ts', 'two'), step('a.ts', 'three')] }]))
    expect(r.staleSteps.map((s) => s.step)).toEqual([2])
    expect(r.walkthroughs[0].steps.map((s) => s.id)).toEqual(['fn:a.ts#one@1', 'fn:a.ts#three@3'])
  })

  it('a step with neither a nodeId nor a file and function is stale, never a throw', () => {
    const r = resolve(graph([]), text([{ title: 'W', steps: [{ text: 'T' }] }]))
    expect(r.staleSteps).toHaveLength(1)
  })

  it('a walkthrough with no live step is still returned, with no steps, so the caller can report it', () => {
    const r = resolve(graph([]), text([{ title: 'W', steps: [step('a.ts', 'x')] }]))
    expect(r.walkthroughs).toHaveLength(1)
    expect(r.walkthroughs[0].steps).toEqual([])
    expect(r.walkthroughs[0].stale).toHaveLength(1)
  })

  it('no walkthrough at all does not throw', () => {
    expect(() => resolve(graph([]), text([]))).not.toThrow()
    expect(() => resolve(graph([]), {})).not.toThrow()
    expect(resolve(graph([]), {}).walkthroughs).toEqual([])
  })
})

describe('resolve: areas', () => {
  const t = (ids) => text([], Object.fromEntries(ids.map((id) => [id, { title: id, what: 'w', why: 'y', leadsTo: 'l' }])))

  it('a removed area is a stale area and its text is not returned', () => {
    const r = resolve(graph([area('area:a@L3')]), t(['area:a@L3', 'area:gone@L3']))
    expect(r.staleAreas).toEqual(['area:gone@L3'])
    expect(Object.keys(r.areas)).toEqual(['area:a@L3'])
  })

  it('a new area without text is undescribed', () => {
    const r = resolve(graph([area('area:a@L3'), area('area:new@L3')]), t(['area:a@L3']))
    expect(r.undescribedAreas).toEqual(['area:new@L3'])
    expect(r.staleAreas).toEqual([])
  })

  it('only a node of kind area counts', () => {
    const r = resolve(graph([page('area:a@L3')]), t(['area:a@L3']))
    expect(r.staleAreas).toEqual(['area:a@L3'])
  })

  it('a text with no areas key does not throw', () => {
    expect(resolve(graph([area('area:a@L3')]), {}).undescribedAreas).toEqual(['area:a@L3'])
  })
})
