// Evasion variants from the adversarial verifier (round 1), each of which
// passed the literal-only scan: a hand-written Dart client must not get
// through by splitting, prefixing or segmenting the spec path.
import { describe, it, expect, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { makeFixtureRepo, MINI_SPEC, writeFile } from './fixture.ts'
import { scanForHandWrittenClients } from './hand-client-scan.ts'

const GOV = {
  ...MINI_SPEC,
  paths: {
    '/api/governance/committees': {},
    '/api/governance/committees/{id}': {},
    '/api/governance/committees/{id}/members': {},
    '/api/governance/committees/{id}/history': {},
    '/api/governance/committees/{id}/provision': {},
    '/api/governance/committees/{id}/roles': {},
    '/api/committees/{id}/child-term': {},
    '/api/groups/{id}': {},
    '/api/health': {},
  },
}

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })
function scan(dart: string): string[] {
  const root = makeFixtureRepo([{ name: 'gov', type: 'openapi', doc: GOV }])
  roots.push(root)
  writeFile(root, 'apps/mobile/lib/api/x.dart', dart)
  return scanForHandWrittenClients(root).problems
}

describe('hand-written client evasions are caught', () => {
  it.each([
    ['ev1 split concatenation', "final p = '/api/governance' + '/committees/' + id;"],
    ['ev1b identifier in the middle', "final p = '/api/committees/' + id + '/child-term';"],
    ['ev2 const base + relative path', "const _base = '/api/governance';\nString p(String id) => '$_base/committees/$id/members';"],
    ['ev2b static const, braces', "class C { static const String base = '/api/governance'; String p(String id) => '${base}/committees/$id/history'; }"],
    ['ev3 Uri(pathSegments:)', "final u = Uri(path: '', pathSegments: ['api', 'governance', 'committees', id, 'roles']);"],
    ['ev3b segments joined', "final p = ['', 'api', 'committees', id, 'child-term'].join('/');"],
    ['ev4 baseUrl carries /api', "final dio = Dio(BaseOptions(baseUrl: 'https://h/api'));\nfinal r = dio.get('/governance/committees/$id/history');"],
    ['ev4b relative collection path', "dio.get('/governance/committees');"],
    ['ev5 adjacent literals', "final p = '/api/governance/' 'committees/$id/provision';"],
    ['ev8 no leading slash', "final p = 'api/governance/committees/$id';"],
    ['quoted interpolation', "final p = \"/api/groups/${ids['a']}\";"],
  ])('%s', (_n, dart) => {
    expect(scan(dart).join('\n')).toMatch(/apps\/mobile\/lib\/api\/x\.dart: hand-written client/)
  })

  it('still passes Dart that names no spec path (no false positive on common text)', () => {
    expect(scan("final u = Uri.parse('https://example.org/api/other/thing');\nfinal s = 'health check';\nconst x = '/api';\n")).toEqual([])
  })
})
