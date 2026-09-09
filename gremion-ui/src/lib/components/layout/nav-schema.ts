import type { AuthHelpers } from '../../auth/group-helpers';
import { Role, hasRole } from '../../auth';
import { termFor } from '$lib/terms';
import { MODULE_MANIFESTS } from '../../modules/registry';
import type { ModuleManifest } from '../../modules/types';

export type NavItem =
  | {
      kind: 'item';
      href: string;
      label: string;
      icon?: string;
      needs?: string[];
      badge?: 'count' | 'live' | 'unread';
      role?: Role;
      moduleId?: string;
      // #289 (HANDOVER-v8 Part F): when set, the label is re-termed via the
      // active tenant's term-map (retermNav). Absent → label is a fixed literal.
      termKey?: string;
    }
  | { kind: 'section'; label: string; needs?: string[]; role?: Role; moduleId?: string; termKey?: string; children: NavItem[] };

/**
 * A module-anchor placeholder in the base nav TEMPLATE. composeNavSchema splices
 * each module's owned `nav` fragment in at the matching slot, then the slot is
 * GONE from the output (the composed tree is pure NavItem[]). Kept off the NavItem
 * union on purpose so every NavItem consumer (filterNavForSession, retermNav,
 * Sidebar, TopBar, CommandPalette) stays untouched — slots never escape
 * composeNavSchema. A slot inside a section's children injects bare items into that
 * section; a top-level slot injects whole sections.
 */
export type ModuleNavSlot = { slot: 'module'; moduleId: string };
/** A template item is exactly a NavItem leaf (no template-only fields). */
type NavTemplateItem = Extract<NavItem, { kind: 'item' }>;
/** A template section mirrors a NavItem section but its children may carry slots. */
type NavTemplateSection = Omit<Extract<NavItem, { kind: 'section' }>, 'children'> & {
  children: NavTemplateEntry[];
};
export type NavTemplateEntry = NavTemplateItem | NavTemplateSection | ModuleNavSlot;

const isModuleSlot = (e: NavTemplateEntry): e is ModuleNavSlot =>
  'slot' in e && e.slot === 'module';

// Governance-only kernel rail. The carved-out feature modules (calendar, tasks,
// files, messages, news, elections, finance) and their rail entries are gone;
// what remains is the governance core: the workspace overview, the Gremien
// section (committees + protokolle/beschlüsse), the portal admin, and the
// Verwaltung section. Feature-module rail entries re-attach via their manifests
// at `{ slot:'module' }` anchors when a module is present — composeNavSchema
// still resolves any such anchors, but the kernel base declares none.
//
// P3-WP1: this is the module-NEUTRAL base template. Module-owned rail entries
// live on their manifests and are woven back in by composeNavSchema; a kernel
// with no feature modules simply has no anchors to fill. composeNavSchema is
// pinned by the deep golden test (nav-schema.test.ts).
export const baseNavSchema: NavTemplateEntry[] = [
  { kind: 'section', label: 'Arbeitsbereich', children: [
    { kind: 'item', href: '/',          label: 'Übersicht',     icon: 'home',      role: Role.Guest },
  ] },
  { kind: 'section', label: 'Gremien', termKey: 'gremien', children: [
    // committees + protokolle are guest-readable (council structure is
    // transparent to any visitor), so the whole Gremien section surfaces for a
    // guest.
    // #289: the committees rail label re-terms per tenant (Ausschüsse & Fraktionen
    // for a Gemeinderat); StuRa tenant #1 has no override → 'Gremien & Referate'.
    { kind: 'item', href: '/committees',  label: 'Gremien & Referate',     icon: 'users', role: Role.Guest, termKey: 'navCommittees' },
    // Merged: the dedicated /beschluesse route still exists, but Protokolle and
    // Beschlüsse share one rail entry (Protokolle's landing surfaces both).
    { kind: 'item', href: '/protokolle',  label: 'Protokolle & Beschlüsse', icon: 'file', role: Role.Guest },
  ] },
  { kind: 'section', label: 'Öffentlichkeit', children: [
    { kind: 'item', href: '/portal', label: 'Portal-Verwaltung', icon: 'globe', role: Role.CouncilAdmin },
  ] },
  { kind: 'section', label: 'Verwaltung', children: [
    { kind: 'item', href: '/members',  label: 'Mitglieder',    icon: 'badge',    role: Role.Member },
    { kind: 'item', href: '/settings', label: 'Einstellungen', icon: 'settings', role: Role.ITAdmin },
    // #264 (HANDOVER-v8 Part C): instance provisioning-convergence status. IT-admin
    // only; the page itself is read-only with it-admin-gated retry actions.
    { kind: 'item', href: '/systemstatus', label: 'Systemstatus', icon: 'activity', role: Role.ITAdmin },
  ] },
];

/**
 * Weave each module's owned `nav` fragment into the module-neutral base template
 * at its `{ slot:'module', moduleId }` anchor (P3-WP1). The result is a pure
 * NavItem[] (every slot resolved/removed). A slot whose module declares no `nav`
 * resolves to nothing (the anchor simply disappears). Recurses into section
 * children so an in-section slot (the elections /votes item) injects bare items,
 * while a top-level slot (the Finanzen section) injects whole sections. Module
 * source order is irrelevant — each fragment lands at its own anchor — so this is
 * byte-identical to the historical literal regardless of MODULE_MANIFESTS order.
 */
export function composeNavSchema(
  base: NavTemplateEntry[],
  manifests: ModuleManifest[],
): NavItem[] {
  const navFor = (moduleId: string): NavItem[] =>
    manifests.find((m) => m.id === moduleId)?.nav ?? [];
  const resolve = (entries: NavTemplateEntry[]): NavItem[] =>
    entries.flatMap((entry) => {
      if (isModuleSlot(entry)) return navFor(entry.moduleId);
      if (entry.kind === 'section') {
        return [{ ...entry, children: resolve(entry.children) }];
      }
      return [entry];
    });
  return resolve(base);
}

// The live rail schema: the module-neutral base with every module's owned nav
// fragment woven back in. Identical to the pre-P3 literal for tenant #1.
export const navSchema: NavItem[] = composeNavSchema(baseNavSchema, MODULE_MANIFESTS);

function isItemVisible(
  item: NavItem,
  helpers: AuthHelpers,
  roles: Role[],
  disabledModules: Set<string>
): boolean {
  // P0.2: a deselected module hides its nav entries outright, before any role/needs check.
  if (item.moduleId && disabledModules.has(item.moduleId)) return false;
  if (item.role && !hasRole(roles, item.role)) return false;
  if (item.needs && !helpers.hasAny(...item.needs)) return false;
  if (item.kind === 'section') {
    return item.children.filter((c) => isItemVisible(c, helpers, roles, disabledModules)).length > 0;
  }
  return true;
}

export function filterNavForSession(
  schema: NavItem[],
  helpers: AuthHelpers,
  roles: Role[],
  disabledModules: Set<string> = new Set()
): NavItem[] {
  return schema
    .filter((item) => isItemVisible(item, helpers, roles, disabledModules))
    .map((item) =>
      item.kind === 'section'
        ? { ...item, children: item.children.filter((c) => isItemVisible(c, helpers, roles, disabledModules)) }
        : item
    );
}

/**
 * #289 (HANDOVER-v8 Part F): re-label nav items that carry a `termKey` using the
 * active tenant's term-map. The DATA shapes never change — only the display
 * label. A tenant with no override (StuRa tenant #1, `terms` absent) resolves
 * every key to its built-in literal via termFor's fallback, so the result is
 * byte-identical for the originator. Applied AFTER filterNavForSession in
 * +layout.server.ts so the server ships a ready-to-render, re-termed tree.
 */
export function retermNav(
  nav: NavItem[],
  terms: Record<string, string> | undefined,
): NavItem[] {
  return nav.map((item) => {
    const label = item.termKey ? termFor(terms, item.termKey, item.label) : item.label;
    if (item.kind === 'section') {
      return { ...item, label, children: retermNav(item.children, terms) };
    }
    return { ...item, label };
  });
}
