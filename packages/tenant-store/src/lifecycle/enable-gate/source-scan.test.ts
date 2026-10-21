// TASK-044 TDD 10 (brief §9: "TDD 10 keeps allow gates out of src/"): an
// EnableGate is implemented only in packages/tenant-store/src/lifecycle/
// enable-gate/** and in test code. Anything else that builds the gate's answer
// (an object literal with isolationTestResultId), declares a value of type
// EnableGate, or returns one, is a second gate: TASK-043's interim
// operatorAllowGate was exactly that.
import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url))
const ALLOWED_DIR = 'packages/tenant-store/src/lifecycle/enable-gate/'
/** Declarations, not implementations: the type itself and its consumer. */
const ALLOWED_FILES = new Set(['packages/tenant-store/src/lifecycle/types.ts'])
const ROOTS = ['packages', 'gremion-ui/src', 'gremion-ui/scripts', 'apps', 'services', 'modules']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.svelte-kit', 'test', 'tests', '__tests__', 'fixtures', '__fixtures__', 'coverage'])
const EXT = /\.(?:ts|mts|cts|js|mjs|cjs)$/
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]s$/

/** Where in `text` a gate is implemented: [line, what]. */
export function gateImplementations(text: string, file = 'x.ts'): [number, string][] {
  if (!/isolationTestResultId|EnableGate/.test(text)) return []
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const hits: [number, string][] = []
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const isGateType = (t: ts.TypeNode | undefined) => !!t && /\bEnableGate\b/.test(t.getText(sf))
  const visit = (n: ts.Node) => {
    if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText(sf) === 'isolationTestResultId') hits.push([line(p), 'builds a gate answer (isolationTestResultId)'])
      }
    }
    if (ts.isVariableDeclaration(n) && isGateType(n.type) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      hits.push([line(n), `declares an EnableGate value (${n.name.getText(sf)})`])
    }
    if ((ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)) && isGateType(n.type) && n.body) {
      hits.push([line(n), 'returns an EnableGate'])
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return hits
}

function sources(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    let entries
    try {
      entries = readdirSync(join(REPO, dir), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(rel)
      } else if (EXT.test(e.name) && !TEST_FILE.test(e.name) && !e.name.endsWith('.d.ts')) out.push(rel)
    }
  }
  for (const r of ROOTS) walk(r)
  return out
}

describe('TDD 10: no EnableGate implementation outside enable-gate/** and test code', () => {
  it('the detector sees an object-literal answer, a typed gate value and a gate-returning function; a consumer is not one', () => {
    expect(gateImplementations("export const g = async () => ({ isolationTestResultId: id, dpiaDecisionId: id })\n").length).toBe(1)
    expect(gateImplementations('const isolationTestResultId = x\nconst r = { isolationTestResultId, dpiaDecisionId }\n').length).toBe(1)
    expect(gateImplementations("import type { EnableGate } from 'x'\nexport const g: EnableGate = () => null\n").length).toBe(1)
    expect(gateImplementations("import type { EnableGate } from 'x'\nexport function allow(): EnableGate { return () => null }\n").length).toBe(1)
    // consumers: a parameter typed EnableGate, a property read, an interface member
    expect(gateImplementations("import type { EnableGate } from 'x'\nexport function run(g: EnableGate) { return g('a', 'b') }\nconst y = r.isolationTestResultId\ninterface P { enableGate: EnableGate; isolationTestResultId: string }\n")).toEqual([])
  })

  it('the tree holds none (every file under packages, gremion-ui/src|scripts, apps, services, modules)', () => {
    const files = sources()
    expect(files.length).toBeGreaterThan(200)
    const found: string[] = []
    for (const f of files) {
      const rel = f.split(sep).join('/')
      if (rel.startsWith(ALLOWED_DIR) || ALLOWED_FILES.has(rel)) continue
      const text = readFileSync(join(REPO, rel), 'utf8')
      for (const [l, what] of gateImplementations(text, rel)) found.push(`${rel}:${l} ${what}`)
    }
    expect(found, `an EnableGate implemented outside ${ALLOWED_DIR} (lifecycle/enable-gate is the one gate)`).toEqual([])
  }, 60_000)
})
