import { describe, test, it, expect, vi, beforeEach } from 'vitest';

// `vi.hoisted` + `vi.mock` is the repo's mocking idiom (see settings.test.ts /
// is-enabled.test.ts): the factory references hoisted `vi.fn()`s rather than
// plain `const`s, which `vi.mock` hoisting would otherwise read before init.
//
// We mock `$lib/server/config` so a test can flip `modules.finance` ON/OFF, and
// `$lib/server/db` so we can hand `loadCounts` a recording `sql` spy and assert
// WHICH queries it issues. `beforeEach` installs finance-ON + a fresh spy so the
// pre-existing role-aware-nav tests below keep passing unchanged.
const { mockReadConfig, mockGetDb } = vi.hoisted(() => ({
  mockReadConfig: vi.fn(),
  mockGetDb: vi.fn(),
}));
vi.mock('$lib/server/config', () => ({ readConfig: mockReadConfig }));
vi.mock('$lib/server/db', () => ({ getDb: mockGetDb }));

import { load } from './+layout.server';
import { Role } from '$lib/auth';
import type { NavItem } from '$lib/components/layout/nav-schema';
import {
  registerDataProvider,
  _resetRuntimeRegistryForTests,
} from '$lib/server/modules/runtime-registry';

// A minimal config the shell's loadBrand()/financeEnabled reads tolerate. Only
// `modules` and `brand`/`org` are touched by the shell load; everything else can
// be omitted (loadBrand try-catches and resolveBrand back-fills defaults).
const configWithFinance = (finance: boolean) => ({
  modules: { files: true, messages: true, calendar: true, users: true, finance, elections: true },
  brand: {
    product: 'Musterrat',
    logo_letter: 'S',
    org_short: 'Muster-HS',
    term: 'SoSe 26',
    version: 'v2.4',
  },
  org: { name: 'Muster-HS', domain: 'stura.example.org' },
});

// A tagged-template `sql` spy that records every query it receives (the static
// template-string parts joined by '?', so the recorded string contains the
// literal SQL but not interpolated values). Returns a benign single COUNT row so
// loadCounts resolves to numeric badges without a real Postgres.
function makeRecordingSql() {
  const queries: string[] = [];
  const sql = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    queries.push(strings.join('?'));
    return Promise.resolve([{ n: 0 }]);
  };
  return { sql, queries };
}

beforeEach(() => {
  // Default posture for the pre-existing nav/counts tests: finance ON, a working
  // (recording) db spy. These tests never inspect `queries`, so the spy is inert
  // for them; the genuine-gate test below overrides readConfig to finance OFF.
  mockReadConfig.mockReturnValue(configWithFinance(true));
  mockGetDb.mockReturnValue(makeRecordingSql().sql);

  // Session-A inversion A3a: the finance pending-approvals COUNT no
  // longer lives in the layout — finance/register.server.ts registers it as a
  // request-time data provider on the runtime-registry, and loadCounts invokes
  // the registered provider (only when canApprove && financeEnabled). In a unit
  // test no register.server.ts barrel runs, so we register the SAME provider the
  // finance module ships, backed by the mocked getDb() so the recording sql spy
  // still observes the `finance.approval` COUNT. Reset first so each test starts
  // from a clean registry, then register the production query.
  _resetRuntimeRegistryForTests();
  registerDataProvider('finance:pending-approvals-count', async () => {
    const sql = mockGetDb() as (s: TemplateStringsArray, ...v: unknown[]) => Promise<{ n: number }[]>;
    const [row] = await sql`SELECT COUNT(*)::int AS n FROM finance.approval WHERE status = 'pending'`;
    return row?.n ?? 0;
  });
});

// `load` is typed as LayoutServerLoad, whose return union includes `void`
// (SvelteKit allows load() to return nothing). Narrow to the runtime shape.
type LoadResult = {
  session: { user: unknown } | null;
  nav: NavItem[];
  counts: { approvals: number; liveVotes: number; unread: number };
};

// Track the invalidation keys `load` registers via event.depends(). The shell
// load declares 'app:unread' so the messages page can refresh the unread badge
// via invalidate('app:unread') without a full navigation.
let dependedKeys: string[] = [];

const eventStub = (roles: Role[] | null, groups: string[] = []) =>
  ({
    // A real LayoutServerLoadEvent always carries `url`; the load reads
    // event.url.pathname for the #290 disabled-module page gate. '/' is not a
    // module route → disabledModuleForPath returns null → no throw.
    url: new URL('http://localhost/'),
    depends: (...keys: string[]) => {
      dependedKeys.push(...keys);
    },
    locals: {
      // P2.2-auth A4: the nav filter consults capabilitiesForTenant(locals.tenant);
      // a config WITHOUT a roles override resolves to the golden CAPABILITIES, so
      // every pre-existing assertion below is byte-identical.
      tenant: { config: {} },
      auth: async () =>
        roles === null
          ? null
          : {
              user: { id: 'u', name: 'Test', email: 't@example.com', roles, groups },
              expires: '2099-01-01T00:00:00.000Z',
            },
    },
  }) as unknown as Parameters<typeof load>[0];

const topLabels = (nav: NavItem[]) => nav.map((i) => i.label);

describe('+layout.server load — role-aware nav filtering', () => {
  test('member session sees the member sections (no Finanzen — carved) but not Öffentlichkeit', async () => {
    // Governance-only kernel: the Finanzen section rode out with the finance
    // module. A member sees Arbeitsbereich + Gremien + Verwaltung; Öffentlichkeit
    // stays council-admin-only, so it remains hidden for a member.
    const result = (await load(eventStub([Role.Member], ['mitglied']))) as LoadResult;
    expect(topLabels(result.nav)).toEqual([
      'Arbeitsbereich',
      'Gremien',
      'Verwaltung',
    ]);
    expect(result.session?.user).toBeTruthy();
  });

  test('it-admin session sees all four kernel sections', async () => {
    const result = (await load(eventStub([Role.ITAdmin], ['admin']))) as LoadResult;
    expect(topLabels(result.nav)).toEqual([
      'Arbeitsbereich',
      'Gremien',
      'Öffentlichkeit',
      'Verwaltung',
    ]);
  });

  test('unauthenticated request returns null session with the guest-visible workspace and Gremien sections', async () => {
    // v6: committees + protokolle are guest-readable, so the Gremien section now
    // surfaces its guest items for an unauthenticated visitor too (the load floors
    // the role set at Guest). Finanzen/Öffentlichkeit/Verwaltung stay hidden.
    const result = (await load(eventStub(null))) as LoadResult;
    expect(result.session).toBeNull();
    expect(topLabels(result.nav)).toEqual(['Arbeitsbereich', 'Gremien']);
  });

  test('returns a numeric counts shape for the sidebar badges', async () => {
    const result = (await load(eventStub([Role.ITAdmin], ['admin']))) as LoadResult;
    expect(result.counts).toEqual({
      approvals: expect.any(Number),
      liveVotes: expect.any(Number),
      unread: expect.any(Number),
    });
  });

  test('exposes a Matrix unread field that defaults to 0 without an access token', async () => {
    // The eventStub provides no locals.accessToken, so loadUnread short-circuits
    // to 0 (it never reaches a live Synapse) — the badge stays hidden.
    const result = (await load(eventStub([Role.Member], ['mitglied']))) as LoadResult;
    expect(result.counts.unread).toBe(0);
  });

  test('registers the app:unread invalidation key so the unread badge can refresh in place', async () => {
    dependedKeys = [];
    await load(eventStub([Role.Member], ['mitglied']));
    expect(dependedKeys).toContain('app:unread');
  });
});

describe('+layout.server load — governance-only kernel counts (finance carved out)', () => {
  // Carve note: the finance approvals COUNT lived behind a finance data provider
  // gated by `canApprove && financeEnabled`. In the governance-only kernel the
  // finance CAPABILITIES are absent (so canApproveAny() is always false) AND no
  // tenant config carries `modules.finance === true` — either gate alone
  // suppresses the query, so the finance provider is NEVER invoked. The always-on
  // liveVotes COUNT (committee_elections — the migration-004 governance bridge)
  // stays kernel-owned and IS always issued. We hand loadCounts a recording `sql`
  // spy and assert on the queries it actually received.
  //
  // The session group used to be an "approver" (ref-finanzen-hv), but with the
  // finance capability gone that grants nothing — which is the point: the finance
  // query is genuinely unreachable in the kernel.
  const FORMER_APPROVER_GROUP = 'ref-finanzen-hv'; // no longer grants anything (kernel CAPABILITIES is empty)

  it('NEVER issues the finance.approval query in the kernel (finance carved out), even for a former approver group', async () => {
    mockReadConfig.mockReturnValue(configWithFinance(false));
    const { sql, queries } = makeRecordingSql();
    mockGetDb.mockReturnValue(sql);

    await load(eventStub([Role.Member], [FORMER_APPROVER_GROUP]));

    // load DID run loadCounts (the always-on committee_elections votes count was
    // issued — the governance bridge) ...
    expect(queries.some((q) => q.includes('committee_elections'))).toBe(true);
    // ... and the finance COUNT was never issued (no finance capability + finance OFF).
    expect(queries.some((q) => q.includes('finance.approval'))).toBe(false);

    // End-to-end nav seam: the layout `load` returns the *filtered* nav, and the
    // Finanzen rail entry is absent in the kernel (the finance module's nav
    // fragment is gone). Flatten every section + child label and assert 'Finanzen'
    // appears nowhere.
    const result = (await load(eventStub([Role.Member], [FORMER_APPROVER_GROUP]))) as LoadResult;
    const allLabels = result.nav.flatMap((entry) =>
      entry.kind === 'section'
        ? [entry.label, ...entry.children.map((c) => c.label)]
        : [entry.label]
    );
    expect(allLabels).not.toContain('Finanzen');
  });

  it('still issues the always-on committee_elections liveVotes COUNT (governance bridge) even with finance config ON', async () => {
    // Even if a stale config still names finance ON, the kernel has no finance
    // capability so canApprove is false → the finance provider is not invoked,
    // while the governance liveVotes COUNT is always issued.
    mockReadConfig.mockReturnValue(configWithFinance(true));
    const { sql, queries } = makeRecordingSql();
    mockGetDb.mockReturnValue(sql);

    await load(eventStub([Role.Member], [FORMER_APPROVER_GROUP]));

    expect(queries.some((q) => q.includes('committee_elections'))).toBe(true);
    expect(queries.some((q) => q.includes('finance.approval'))).toBe(false);
  });
});
