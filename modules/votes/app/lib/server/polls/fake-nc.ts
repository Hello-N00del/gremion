// In-memory Nextcloud Polls (OCS) double shared by the tenant-isolation suites.
// One stateful "Nextcloud" = one shared instance serving every tenant, which is
// exactly the deployment the isolation has to hold on.
export interface FakePoll {
  id: number
  type: string
  title: string
  description: string
  anonymous: boolean
  expire: number
  options: { id: number; text: string }[]
  voters: Map<string, Set<number>> // voter token -> option ids
}

export function makeFakeNc() {
  const polls = new Map<number, FakePoll>()
  let nextPoll = 1
  let nextOption = 100
  const calls: { method: string; path: string; auth: string }[] = []

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify({ ocs: { meta: { status: status === 200 ? 'ok' : 'failure' }, data } }), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  function view(p: FakePoll, who: string) {
    return {
      id: p.id,
      type: p.type,
      configuration: { title: p.title, description: p.description, allowComment: false, anonymous: p.anonymous, expire: p.expire },
      status: { expired: p.expire > 0 && p.expire * 1000 < Date.now(), countOptions: p.options.length },
      currentUserStatus: { userRole: 'voter', isLocked: false, countVotes: p.voters.get(who)?.size ?? 0 },
    }
  }

  async function handler(url: string, init: RequestInit = {}): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase()
    const path = url.replace(/^.*\/api\/v1\.0/, '')
    const who = String((init.headers as Record<string, string> | undefined)?.Authorization ?? '')
    calls.push({ method, path, auth: who })
    const body = init.body ? (JSON.parse(init.body as string) as Record<string, any>) : {}
    let m: RegExpMatchArray | null
    if (method === 'GET' && path === '/polls') return json({ polls: [...polls.values()].map((p) => view(p, who)) })
    if (method === 'POST' && path === '/poll') {
      const p: FakePoll = { id: nextPoll++, type: body.type, title: body.title, description: '', anonymous: false, expire: 0, options: [], voters: new Map() }
      polls.set(p.id, p)
      return json({ poll: view(p, who) })
    }
    if ((m = path.match(/^\/poll\/(\d+)\/options$/))) {
      const p = polls.get(Number(m[1]))
      if (!p) return json({}, 404)
      if (method === 'GET') {
        return json({
          options: p.options.map((o) => ({
            id: o.id,
            text: o.text,
            votes: { count: [...p.voters.values()].filter((s) => s.has(o.id)).length, yes: 0, no: 0, maybe: 0, currentUser: null },
          })),
        })
      }
      for (const t of String(body.text).split('\n')) p.options.push({ id: nextOption++, text: t })
      return json({ options: p.options })
    }
    if ((m = path.match(/^\/poll\/(\d+)$/))) {
      const p = polls.get(Number(m[1]))
      if (!p) return json({}, 404)
      if (method === 'GET') return json({ poll: view(p, who) })
      if (method === 'DELETE') {
        polls.delete(p.id)
        return json({})
      }
      if (method === 'PUT') {
        const c = body.pollConfiguration ?? {}
        if (c.anonymous !== undefined) p.anonymous = c.anonymous
        if (c.description !== undefined) p.description = c.description
        if (c.expire !== undefined) p.expire = c.expire
        return json({ poll: view(p, who) })
      }
    }
    if (method === 'PUT' && (m = path.match(/^\/option\/(\d+)\/vote\/yes$/))) {
      const oid = Number(m[1])
      const p = [...polls.values()].find((x) => x.options.some((o) => o.id === oid))
      if (!p) return json({}, 404)
      p.voters.set(who, (p.voters.get(who) ?? new Set()).add(oid))
      return json({ ok: true })
    }
    return json({}, 404)
  }
  return { polls, calls, handler }
}
