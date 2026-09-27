// TRD-413 guard (TASK-082 brief section 6 item 7): raw <dialog>/<select> and
// dialog/listbox/combobox/menu roles outside primitives/** in the F2
// governance route tree and every $lib component it imports.
import { describe, test, expect } from 'vitest'
import { join } from 'node:path'

import {
  PRIMITIVE_GUARD_SCOPE,
  checkPrimitiveRoles,
  diskFs,
  findViolations,
  formatResult,
  importsOf,
  type GuardFs,
} from './guard/primitive-roles.mjs'

const APP_ROOT = join(__dirname, '..', '..', '..', '..')

/** An in-memory GuardFs: keys are appRoot-relative file paths. */
function memFs(files: Record<string, string>): GuardFs {
  const paths = Object.keys(files)
  const isDir = (p: string) => paths.some((f) => f.startsWith(`${p}/`))
  return {
    exists: (p) => p in files || isDir(p),
    isDir,
    list: (p) => [...new Set(paths.filter((f) => f.startsWith(`${p}/`)).map((f) => f.slice(p.length + 1).split('/')[0]))],
    read: (p) => {
      if (!(p in files)) throw new Error(`no fixture file ${p}`)
      return files[p]
    },
  }
}

const ROUTE = 'src/routes/sitzungen/+page.svelte'

describe('TRD-413 primitive-roles guard', () => {
  test('the scope constant is the F2 governance route tree', () => {
    expect(PRIMITIVE_GUARD_SCOPE.f2Governance).toEqual(['src/routes/sitzungen'])
    expect(Object.isFrozen(PRIMITIVE_GUARD_SCOPE)).toBe(true)
  })

  test('named case: a tree with no routes/sitzungen is reported as empty-scope, not a silent zero', () => {
    const fs = memFs({ 'src/routes/members/+page.svelte': '<select></select>\n' })
    const r = checkPrimitiveRoles({ fs })
    expect(r.status).toBe('empty-scope')
    expect(r.reason).toContain('src/routes/sitzungen')
    expect(r.reason).toContain('TASK-095/096/097')
    expect(r.violations).toEqual([])
    expect(formatResult(r)).toMatch(/^\[primitive-roles\] PASS \(empty-scope\)/)
  })

  // The real tree is empty-scope today (no routes/sitzungen on main); once
  // TASK-095/096/097 create it, the same test must keep passing for compliant
  // screens and turn RED only on a real violation -- so it asserts the
  // violations, never the status alone.
  test('on the real tree the F2 governance scope has no violations (empty-scope today, scanned once the screens land)', () => {
    const r = checkPrimitiveRoles({ fs: diskFs(APP_ROOT) })
    expect(r.violations).toEqual([])
    expect(['empty-scope', 'scanned']).toContain(r.status)
    // Either branch must explain itself: empty-scope names the missing tree,
    // scanned must have walked at least one file and printed a PASS line.
    const explained =
      r.status === 'empty-scope'
        ? (r.reason ?? '').includes('src/routes/sitzungen')
        : r.scanned.length > 0 && /^\[primitive-roles\] scanned \d+ file\(s\) .*: PASS, /.test(formatResult(r))
    expect({ status: r.status, explained }).toEqual({ status: r.status, explained: true })
  })

  test('a compliant F2 screen (primitives only) scans clean -- the real-tree test does not fail merely because routes/sitzungen exists', () => {
    const fs = memFs({
      [ROUTE]: "<script lang=\"ts\">\n  import Dialog from '$lib/components/primitives/Dialog.svelte'\n</script>\n<Dialog title=\"t\" closeLabel=\"c\" />\n",
      'src/lib/components/primitives/Dialog.svelte': '<div role="dialog"></div>',
    })
    const r = checkPrimitiveRoles({ fs })
    expect(r.status).toBe('scanned')
    expect(r.violations).toEqual([])
  })

  test('a fixture route with a raw <select> is RED, naming the file and line', () => {
    const fs = memFs({
      [ROUTE]: '<script lang="ts">\n  let v = $state("")\n</script>\n\n<label>Art <select bind:value={v}><option>a</option></select></label>\n',
    })
    const r = checkPrimitiveRoles({ fs })
    expect(r.status).toBe('scanned')
    expect(r.violations).toEqual([{ file: ROUTE, line: 5, kind: 'raw-tag', match: '<select>' }])
    expect(formatResult(r)).toContain(`${ROUTE}:5 <select>`)
  })

  test('a $lib component with div role="dialog", imported by the route, is RED, naming the component (the import-graph walk)', () => {
    const fs = memFs({
      [ROUTE]: "<script lang=\"ts\">\n  import { Panel } from '$lib/components/meeting'\n</script>\n<Panel />\n",
      'src/lib/components/meeting/index.ts': "export { default as Panel } from './Panel.svelte'\n",
      'src/lib/components/meeting/Panel.svelte': "<script lang=\"ts\">\n  import Inner from './Inner.svelte'\n</script>\n<Inner />\n",
      'src/lib/components/meeting/Inner.svelte': '<div class="x">\n  <div role="dialog" aria-modal="true">hi</div>\n</div>\n',
      'src/lib/components/unrelated/Other.svelte': '<dialog open>not imported by the route</dialog>\n',
    })
    const r = checkPrimitiveRoles({ fs })
    expect(r.violations).toEqual([
      { file: 'src/lib/components/meeting/Inner.svelte', line: 2, kind: 'role', match: 'role="dialog"' },
    ])
    expect(r.scanned).toEqual([
      'src/lib/components/meeting/Inner.svelte',
      'src/lib/components/meeting/Panel.svelte',
      'src/lib/components/meeting/index.ts',
      ROUTE,
    ])
  })

  test('the primitives themselves, menuitem/option roles, PascalCase components and comments are not flagged', () => {
    const fs = memFs({
      [ROUTE]: [
        '<script lang="ts">',
        "  import Select from '$lib/components/primitives/Select.svelte'",
        "  import Dialog from '$lib/components/primitives/Dialog.svelte'",
        '  // a <select> in a comment',
        '</script>',
        '<!-- <dialog> in a markup comment, role="menu" too -->',
        '<Select label="x" placeholder="y" options={[]} />',
        '<Dialog title="t" closeLabel="c" />',
        '<li role="menuitem">a</li><li role="option">b</li><div role="menubarx"></div>',
      ].join('\n'),
      'src/lib/components/primitives/Select.svelte': '<div role="listbox"></div><select></select>',
      'src/lib/components/primitives/Dialog.svelte': '<div role="dialog"></div>',
    })
    const r = checkPrimitiveRoles({ fs })
    expect(r.violations).toEqual([])
    expect(r.scanned).toContain('src/lib/components/primitives/Select.svelte')
  })

  test('every flagged role and raw tag form is caught', () => {
    const text = [
      '<div role="dialog"></div>',
      "<div role='alertdialog'></div>",
      '<ul role={"listbox"}></ul>',
      '<input role="combobox" />',
      '<div role="menu"></div>',
      '<div role="menubar"></div>',
      '<dialog open></dialog>',
      '<select></select>',
      '<svelte:element this="dialog" />',
    ].join('\n')
    expect(findViolations('f.svelte', text).map((v) => `${v.line}:${v.match}`)).toEqual([
      '7:<dialog>',
      '8:<select>',
      '9:<svelte:element this="dialog">',
      '1:role="dialog"',
      '2:role="alertdialog"',
      '3:role="listbox"',
      '4:role="combobox"',
      '5:role="menu"',
      '6:role="menubar"',
    ])
  })

  test('an import the walk cannot resolve is a finding (no vacuous pass)', () => {
    const fs = memFs({
      [ROUTE]: "<script>\n  import Gone from '$lib/components/Gone.svelte'\n  import { page } from '$app/state'\n  import { Dialog } from 'bits-ui'\n</script>\n",
    })
    const r = checkPrimitiveRoles({ fs })
    expect(r.violations).toEqual([{ file: ROUTE, line: 2, kind: 'unresolved-import', match: '$lib/components/Gone.svelte' }])
  })

  test('importsOf reads static, type-only, multi-line, re-export and dynamic imports', () => {
    const src = [
      "import A from './A.svelte'",
      "import type { T } from '$lib/t'",
      'import {',
      '  b,',
      '  c as d,',
      "} from '../b'",
      "export * from './star'",
      "export { x as y } from './re'",
      "const lazy = () => import('./Lazy.svelte')",
      "import './side-effect.css'",
    ].join('\n')
    expect(importsOf(src)).toEqual(['./A.svelte', '$lib/t', '../b', './side-effect.css', './star', './re', './Lazy.svelte'])
  })

  test('on the real tree, a scope that holds raw consumers is RED (the guard is not blind to real files)', () => {
    const r = checkPrimitiveRoles({ fs: diskFs(APP_ROOT), roots: ['src/routes/members/committees'] })
    expect(r.status).toBe('scanned')
    const files = new Set(r.violations.map((v) => v.file))
    expect(files).toContain('src/routes/members/committees/new/+page.svelte')
    expect(r.violations.filter((v) => v.kind === 'unresolved-import')).toEqual([])
  })
})
