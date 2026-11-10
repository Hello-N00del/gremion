// resolve.mjs - joins the written text to a graph. PURE: no file, no network, no clock.
//
// A walkthrough step names its code in one of two ways. Both survive a moved line, because a line number
// is never part of the match:
//   { text, file, function }   the function node with this file and this name
//   { text, nodeId }           the node with exactly this id (page:, route:, table:, file: ids hold no line)
// A step that matches nothing is STALE. It is reported, never thrown, so a refactor in the code can only
// make the map say so; it can never stop a build.

const idTail = (id) => String(id).replace(/^[a-z]+:/, '').replace(/@[^@/]*$/, '')
// A job id is the workflow file and the job: the file name and the job are enough to find it (ci.yml#lint).
const shortName = (id) => idTail(id).split('/').slice(String(id).startsWith('job:') ? -1 : -2).join('/')

/**
 * @param {{ nodes?: Array<{id:string,kind:string,name:string,file?:string,line?:number}> }} graph
 * @param {{ walkthroughs?: Array<{title:string,steps:Array<object>}>, areas?: Record<string, object> }} text
 */
export function resolve(graph, text) {
  const nodes = graph?.nodes ?? []
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const fnsByKey = new Map()
  for (const n of nodes) {
    if (n.kind !== 'function') continue
    const k = `${n.file}\u0000${n.name}`
    if (!fnsByKey.has(k)) fnsByKey.set(k, [])
    fnsByKey.get(k).push(n)
  }

  const staleSteps = []
  const ambiguousSteps = []
  const walkthroughs = (text?.walkthroughs ?? []).map((w) => {
    const steps = []
    const stale = []
    ;(w.steps ?? []).forEach((s, idx) => {
      const position = idx + 1
      let hit = null
      if (typeof s.file === 'string' && typeof s.function === 'string') {
        const all = (fnsByKey.get(`${s.file}\u0000${s.function}`) ?? []).slice().sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.id < b.id ? -1 : 1))
        if (all.length) {
          hit = all[0]
          if (all.length > 1) ambiguousSteps.push({ walkthrough: w.title, step: position, file: s.file, function: s.function, matches: all.length, line: hit.line ?? 0 })
        }
      } else if (typeof s.nodeId === 'string') {
        hit = byId.get(s.nodeId) ?? null
      }
      if (hit) {
        steps.push({ text: s.text, id: hit.id })
        return
      }
      const entry = { walkthrough: w.title, step: position }
      if (typeof s.file === 'string' && typeof s.function === 'string') {
        entry.file = s.file
        entry.function = s.function
      } else if (typeof s.nodeId === 'string') entry.nodeId = s.nodeId
      entry.text = s.text
      staleSteps.push(entry)
      stale.push({ step: position, name: typeof s.function === 'string' ? s.function : typeof s.nodeId === 'string' ? shortName(s.nodeId) : 'unknown', text: s.text })
    })
    return { title: w.title, steps, stale }
  })

  const written = text?.areas ?? {}
  const areaIds = nodes.filter((n) => n.kind === 'area').map((n) => n.id)
  const areaSet = new Set(areaIds)
  const areas = {}
  for (const [id, a] of Object.entries(written)) if (areaSet.has(id)) areas[id] = a
  const staleAreas = Object.keys(written).filter((id) => !areaSet.has(id))
  const undescribedAreas = areaIds.filter((id) => !(id in written)).sort()

  return { walkthroughs, areas, staleSteps, staleAreas, undescribedAreas, ambiguousSteps }
}
