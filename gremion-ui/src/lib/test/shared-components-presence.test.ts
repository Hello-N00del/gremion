import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const appCss = readFileSync(join(__dirname, '../../app.css'), 'utf8');

// The shared component layer (PR 1.5) the surface PRs (2/3/4) consume instead
// of re-scoping these generics per component.
const sharedClasses = [
  '.eyebrow', '.mono', '.display',
  '.card', '.card-pad', '.grid-2', '.grid-3', '.kpi-grid', '.section-head',
  '.kpi', '.row',
  '.pill', '.pill-accent', '.pill-success', '.pill-warn', '.pill-danger', '.pill-live',
  '.btn', '.btn-primary', '.btn-ghost', '.btn-sm',
  '.signer-trail', '.signer-step',
  '.fin-tabs', '.fin-tab',
  '.budget-group', '.budget-group-head', '.bar-track', '.bar-fill',
  '.suborg-card',
  '.empty-state',
] as const;

describe('PR 1.5 shared component layer — class presence in app.css', () => {
  for (const cls of sharedClasses) {
    test(`${cls} is declared`, () => {
      const esc = cls.replace(/[-.]/g, (m) => '\\' + m);
      // whole-token match: not immediately followed by '-' or a word char,
      // so '.card' does not falsely match inside '.card-pad'.
      const re = new RegExp(`${esc}(?![-\\w])`);
      expect(appCss).toMatch(re);
    });
  }
});

describe('PR 1.5 shared layer — AA: pill/chip text on *-soft uses *-ink (§16 finding 1)', () => {
  const blockOf = (sel: string) =>
    appCss.match(new RegExp(`${sel.replace(/[-.]/g, (m) => '\\' + m)}\\s*\\{[^}]*\\}`))?.[0] ?? '';

  test('.pill-warn text uses --ember-ink', () => {
    expect(blockOf('.pill-warn')).toMatch(/color:\s*var\(--ember-ink\)/);
  });
  test('.pill-danger text uses --rust-ink', () => {
    expect(blockOf('.pill-danger')).toMatch(/color:\s*var\(--rust-ink\)/);
  });
  test('.pill-success text uses --pine-ink', () => {
    expect(blockOf('.pill-success')).toMatch(/color:\s*var\(--pine-ink\)/);
  });
});

describe('PR 1.5 shared layer — pulse keyframes drive live pills + pending signer dot', () => {
  test('@keyframes pulse is declared', () => {
    expect(appCss).toMatch(/@keyframes\s+pulse\s*\{/);
  });
});
