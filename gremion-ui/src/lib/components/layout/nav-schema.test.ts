import { describe, test, expect } from 'vitest';
import { navSchema, baseNavSchema, composeNavSchema, filterNavForSession, retermNav, type NavItem } from './nav-schema';
import { MODULE_MANIFESTS } from '../../modules/registry';
import { makeAuthHelpers } from '../../auth/group-helpers';
import { Role } from '../../auth';

const filterFor = (groups: string[], roles: Role[]) =>
  filterNavForSession(navSchema, makeAuthHelpers({ user: { groups } }), roles);

const topLabels = (nav: NavItem[]) => nav.map((i) => i.label);

const sectionChildren = (nav: NavItem[], label: string): string[] => {
  const section = nav.find((i) => i.kind === 'section' && i.label === label);
  if (!section || section.kind !== 'section') return [];
  return section.children.map((c) => c.label);
};

// DEEP full-tree golden — the kernel rail plus the rail entries of the module halves the build composes
// (TASK-205: calendar, tasks, files and chat inline in Arbeitsbereich as in the source; the votes entry and
// the Räume entry woven in at their `{ slot:'module' }` anchors from their manifests). Modules that are not
// built (finance, vault, handover) contribute nothing. The composed tree equals the base template
// with its slots resolved, and the exported navSchema equals it too.
const NAV_SCHEMA_GOLDEN: NavItem[] = [
  { kind: 'section', label: 'Arbeitsbereich', children: [
    { kind: 'item', href: '/',          label: 'Übersicht',     icon: 'home',      role: Role.Guest },
    { kind: 'item', href: '/calendar',  label: 'Kalender',      icon: 'calendar',  role: Role.Guest, moduleId: 'calendar' },
    { kind: 'item', href: '/tasks',     label: 'Aufgaben',      icon: 'checklist', role: Role.Member, moduleId: 'board' },
    { kind: 'item', href: '/files',     label: 'Dokumente',     icon: 'folder',    role: Role.Member, moduleId: 'files' },
    { kind: 'item', href: '/messages',  label: 'Matrix · Chat', icon: 'chat',      role: Role.Member, badge: 'unread', moduleId: 'messages' },
  ] },
  { kind: 'section', label: 'Gremien', termKey: 'gremien', children: [
    { kind: 'item', href: '/committees',  label: 'Gremien & Referate',     icon: 'users', role: Role.Guest, termKey: 'navCommittees' },
    { kind: 'item', href: '/protokolle',  label: 'Protokolle & Beschlüsse', icon: 'file', role: Role.Guest },
    { kind: 'item', href: '/votes', label: 'Abstimmungen & Wahlen', icon: 'vote', role: Role.Member, badge: 'live', moduleId: 'votes', labelIfOff: { moduleId: 'elections', label: 'Abstimmungen' } },
  ] },
  { kind: 'section', label: 'Öffentlichkeit', children: [
    { kind: 'item', href: '/portal', label: 'Portal-Verwaltung', icon: 'globe', role: Role.CouncilAdmin },
    { kind: 'item', href: '/content', label: 'Inhalte', icon: 'newspaper', role: Role.CouncilAdmin, moduleId: 'content' },
  ] },
  { kind: 'section', label: 'Verwaltung', children: [
    { kind: 'item', href: '/members',  label: 'Mitglieder',    icon: 'badge',    role: Role.Member },
    { kind: 'item', href: '/messages/manage', label: 'Räume', icon: 'matrix', role: Role.CouncilAdmin, moduleId: 'messages' },
    { kind: 'item', href: '/settings', label: 'Einstellungen', icon: 'settings', role: Role.ITAdmin },
    { kind: 'item', href: '/systemstatus', label: 'Systemstatus', icon: 'activity', role: Role.ITAdmin },
  ] },
];

describe('navSchema deep full-tree golden (kernel rail + composed module entries)', () => {
  test('composeNavSchema(baseNavSchema, MODULE_MANIFESTS) reproduces the golden tree byte-for-byte', () => {
    expect(composeNavSchema(baseNavSchema, MODULE_MANIFESTS)).toEqual(NAV_SCHEMA_GOLDEN);
  });

  test('the exported navSchema equals the golden tree (composition is the source of truth)', () => {
    expect(navSchema).toEqual(NAV_SCHEMA_GOLDEN);
  });
});

describe('navSchema initial shape', () => {
  test('top level is the four kernel sections', () => {
    expect(topLabels(navSchema)).toEqual([
      'Arbeitsbereich',
      'Gremien',
      'Öffentlichkeit',
      'Verwaltung',
    ]);
  });

  test('is exactly 14 items across 4 sections (kernel rail + the composed module entries)', () => {
    // Arbeitsbereich(5: Übersicht, Kalender, Aufgaben, Dokumente, Chat) + Gremien(3: committees, protokolle,
    // Abstimmungen & Wahlen) + Öffentlichkeit(2: portal, Inhalte) + Verwaltung(4: members, Räume, settings, systemstatus).
    const items = navSchema.flatMap((s) => (s.kind === 'section' ? s.children : [s]));
    expect(navSchema.length).toBe(4);
    expect(items.length).toBe(14);
  });

  test('Arbeitsbereich carries Übersicht and the workspace entries of the composed modules', () => {
    expect(sectionChildren(navSchema, 'Arbeitsbereich')).toEqual([
      'Übersicht',
      'Kalender',
      'Aufgaben',
      'Dokumente',
      'Matrix · Chat',
    ]);
  });

  test('Gremien merges Protokolle+Beschlüsse and carries the votes module entry', () => {
    expect(sectionChildren(navSchema, 'Gremien')).toEqual([
      'Gremien & Referate',
      'Protokolle & Beschlüsse',
      'Abstimmungen & Wahlen',
    ]);
  });

  test('Öffentlichkeit carries Portal-Verwaltung and the Inhalte entry of the content module', () => {
    expect(sectionChildren(navSchema, 'Öffentlichkeit')).toEqual([
      'Portal-Verwaltung',
      'Inhalte',
    ]);
  });
});

describe('filterNavForSession — guest (unauthenticated / no elevated role)', () => {
  const nav = filterFor([], [Role.Guest]);

  test('sees Arbeitsbereich and the guest-readable Gremien section', () => {
    // committees + protokolle are guest-readable, so the Gremien section
    // surfaces its guest items.
    expect(topLabels(nav)).toEqual(['Arbeitsbereich', 'Gremien']);
  });

  test('sees the guest Arbeitsbereich items (Übersicht, Kalender)', () => {
    expect(sectionChildren(nav, 'Arbeitsbereich')).toEqual([
      'Übersicht',
      'Kalender',
    ]);
  });

  test('Gremien shows the guest items (committees + protokolle)', () => {
    expect(sectionChildren(nav, 'Gremien')).toEqual([
      'Gremien & Referate',
      'Protokolle & Beschlüsse',
    ]);
  });
});

describe('filterNavForSession — member (mitglied, no elevated groups)', () => {
  const nav = filterFor(['mitglied'], [Role.Member]);

  test('sees Arbeitsbereich, Gremien and Verwaltung', () => {
    expect(topLabels(nav)).toEqual([
      'Arbeitsbereich',
      'Gremien',
      'Verwaltung',
    ]);
  });

  test('Arbeitsbereich shows the member workspace entries and Gremien the votes entry', () => {
    expect(sectionChildren(nav, 'Arbeitsbereich')).toEqual(['Übersicht', 'Kalender', 'Aufgaben', 'Dokumente', 'Matrix · Chat']);
    expect(sectionChildren(nav, 'Gremien')).toContain('Abstimmungen & Wahlen');
  });

  test('Verwaltung shows Mitglieder but neither Räume (council-admin) nor Einstellungen', () => {
    expect(sectionChildren(nav, 'Verwaltung')).toEqual(['Mitglieder']);
  });

  test('does not see Öffentlichkeit', () => {
    expect(topLabels(nav)).not.toContain('Öffentlichkeit');
  });
});

describe('filterNavForSession — council-admin', () => {
  const nav = filterFor([], [Role.CouncilAdmin]);

  test('sees the Öffentlichkeit section with the portal admin item', () => {
    expect(topLabels(nav)).toContain('Öffentlichkeit');
    expect(sectionChildren(nav, 'Öffentlichkeit')).toEqual([
      'Portal-Verwaltung',
      'Inhalte',
    ]);
  });

  test('Verwaltung shows Mitglieder, not Einstellungen', () => {
    const children = sectionChildren(nav, 'Verwaltung');
    expect(children).toContain('Mitglieder');
    expect(children).toContain('Räume'); // the messages module's rail entry is council-admin gated
    expect(children).not.toContain('Einstellungen');
  });
});

describe('filterNavForSession — it-admin with admin group sees everything', () => {
  const nav = filterFor(['admin'], [Role.ITAdmin]);

  test('shows all four sections', () => {
    expect(topLabels(nav)).toEqual([
      'Arbeitsbereich',
      'Gremien',
      'Öffentlichkeit',
      'Verwaltung',
    ]);
  });

  test('Verwaltung shows Mitglieder + Räume + Einstellungen + Systemstatus', () => {
    expect(sectionChildren(nav, 'Verwaltung')).toEqual(['Mitglieder', 'Räume', 'Einstellungen', 'Systemstatus']);
  });
});

describe('filterNavForSession — empty sections collapse entirely', () => {
  const syntheticSchema: NavItem[] = [
    { kind: 'item', href: '/always', label: 'Always', icon: 'home' },
    {
      kind: 'section',
      label: 'NurAdmin',
      children: [
        { kind: 'item', href: '/y', label: 'Y', icon: 'key', needs: ['admin'] },
        { kind: 'item', href: '/z', label: 'Z', icon: 'lock', needs: ['it-admin'] },
      ],
    },
  ];

  test('section with all-gated children disappears for a non-privileged session', () => {
    const nav = filterNavForSession(
      syntheticSchema,
      makeAuthHelpers({ user: { groups: ['mitglied'] } }),
      []
    );
    expect(nav.map((i) => i.label)).toEqual(['Always']);
  });

  test('section reappears with only the visible children for a privileged session', () => {
    const nav = filterNavForSession(
      syntheticSchema,
      makeAuthHelpers({ user: { groups: ['admin'] } }),
      []
    );
    expect(nav.map((i) => i.label)).toEqual(['Always', 'NurAdmin']);
    expect(sectionChildren(nav, 'NurAdmin')).toEqual(['Y']);
  });
});

describe('filterNavForSession module gating (P0.2)', () => {
  // The kernel base declares no module-owned nav items, so module-disable sets do
  // not remove any kernel rail entry — but the gating seam (disabledModules) must
  // still pass through harmlessly. A synthetic module-tagged schema proves the
  // gate still hides a module item when present, so re-attached modules gate.
  const gateHelpers = { hasAny: () => true, canApproveAny: () => true } as any;
  const allRoles = [Role.ITAdmin, Role.CouncilAdmin, Role.Member, Role.Guest];

  const labels = (nav: NavItem[]): string[] =>
    nav.flatMap((s) =>
      s.kind === 'section'
        ? s.children.map((c) => ('label' in c ? c.label : ''))
        : [s.kind === 'item' ? s.label : ''],
    );

  const moduleSchema: NavItem[] = [
    { kind: 'section', label: 'Demo', moduleId: 'demo_widget', children: [
      { kind: 'item', href: '/demo', label: 'Demo-Eintrag', icon: 'package', role: Role.Member, moduleId: 'demo_widget' },
    ] },
  ];

  test('shows a module item when its module is enabled', () => {
    const nav = filterNavForSession(moduleSchema, gateHelpers, allRoles, new Set());
    expect(labels(nav)).toContain('Demo-Eintrag');
  });

  test('hides a module item when its module is disabled', () => {
    const nav = filterNavForSession(moduleSchema, gateHelpers, allRoles, new Set(['demo_widget']));
    expect(labels(nav)).not.toContain('Demo-Eintrag');
  });

  test('kernel rail entries are unaffected by module-disable sets', () => {
    const nav = filterNavForSession(navSchema, gateHelpers, allRoles, new Set(['demo_widget']));
    expect(labels(nav)).toContain('Gremien & Referate');
    expect(labels(nav)).toContain('Protokolle & Beschlüsse');
  });
});

// Pilot surface: every module-owned rail entry hides when its module is off, so no link dangles into the
// module-disabled surface, and with elections off nothing of the rail names elections or Wahlen.
describe('filterNavForSession — a deselected module drops its rail entry (pilot surface)', () => {
  const everything = makeAuthHelpers({ user: { groups: ['admin', 'it-admin'] } });
  const roles = [Role.ITAdmin, Role.CouncilAdmin, Role.Member, Role.Guest];
  const hrefs = (nav: NavItem[]): string[] =>
    nav.flatMap((i) => (i.kind === 'section' ? i.children.flatMap((c) => ('href' in c ? [c.href] : [])) : [i.href]));
  const all = filterNavForSession(navSchema, everything, roles, new Set());

  test.each([
    ['calendar', '/calendar'],
    ['files', '/files'],
    ['messages', '/messages'],
    ['board', '/tasks'],
    ['content', '/content'],
    ['votes', '/votes'],
  ])('deselecting %s removes %s and keeps the others', (moduleId, href) => {
    expect(hrefs(all)).toContain(href);
    const off = hrefs(filterNavForSession(navSchema, everything, roles, new Set([moduleId])));
    expect(off).not.toContain(href);
    expect(off.length).toBeLessThan(hrefs(all).length);
    expect(off).toContain('/committees');
  });

  test('with elections off the composed nav has no /elections href and no label containing Wahlen', () => {
    const nav = filterNavForSession(navSchema, everything, roles, new Set(['elections']));
    const labels = nav.flatMap((i) => (i.kind === 'section' ? [i.label, ...i.children.map((c) => c.label)] : [i.label]));
    expect(hrefs(nav).some((h) => h.startsWith('/elections'))).toBe(false);
    expect(labels.filter((l) => /wahl/i.test(l))).toEqual([]);
    expect(labels).toContain('Abstimmungen');
  });

  test('the elections-off wording only applies when elections is off (default kernel wording kept otherwise)', () => {
    const labels = (nav: NavItem[]) => nav.flatMap((i) => (i.kind === 'section' ? i.children.map((c) => c.label) : [i.label]));
    expect(labels(all)).toContain('Abstimmungen & Wahlen');
    expect(labels(all)).not.toContain('Abstimmungen');
  });

  test('no base template item names /elections (the module has no rail entry of its own)', () => {
    const flat = (e: unknown): string[] => JSON.stringify(e).match(/"href":"[^"]*"/g) ?? [];
    expect(flat(navSchema).some((h) => h.includes('/elections'))).toBe(false);
  });
});

describe('retermNav — #289 per-tenant vocabulary (HANDOVER-v8 Part F)', () => {
  test('tenant #1 (no term-map) is BYTE-IDENTICAL to the un-termed nav', () => {
    const nav = filterFor(['admin'], [Role.ITAdmin]);
    expect(retermNav(nav, undefined)).toEqual(nav);
    expect(retermNav(nav, {})).toEqual(nav);
  });

  test('re-terms the Gremien section label + the committees rail item by termKey', () => {
    const nav = filterFor(['admin'], [Role.ITAdmin]);
    const termed = retermNav(nav, {
      gremien: 'Ausschüsse',
      navCommittees: 'Ausschüsse & Fraktionen',
    });
    const gremien = termed.find((i) => i.kind === 'section' && i.label === 'Ausschüsse');
    expect(gremien).toBeTruthy();
    expect(sectionChildren(termed, 'Ausschüsse')).toContain('Ausschüsse & Fraktionen');
    // the original literal is gone
    expect(sectionChildren(termed, 'Ausschüsse')).not.toContain('Gremien & Referate');
  });

  test('leaves items WITHOUT a termKey untouched even when a term-map is present', () => {
    const nav = filterFor(['admin'], [Role.ITAdmin]);
    const termed = retermNav(nav, { gremien: 'Ausschüsse', navCommittees: 'X' });
    // Öffentlichkeit / Verwaltung carry no termKey → unchanged
    expect(termed.map((i) => i.label)).toContain('Öffentlichkeit');
    expect(termed.map((i) => i.label)).toContain('Verwaltung');
  });

  test('an unrelated term key never bleeds into a non-keyed label', () => {
    const nav = filterFor(['admin'], [Role.ITAdmin]);
    const termed = retermNav(nav, { gremien: 'Ausschüsse' });
    // navCommittees not provided → committees item keeps its literal
    expect(sectionChildren(termed, 'Ausschüsse')).toContain('Gremien & Referate');
  });
});
