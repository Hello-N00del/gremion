import { describe, test, expect } from 'vitest';
import { makeAuthHelpers } from './group-helpers';
import type { CapabilityId } from './capabilities';

type Session = { user: { id: string; groups: string[] } };

const sessions: Record<string, Session> = {
  none:        { user: { id: 'u1', groups: [] } },
  mitglied:    { user: { id: 'u2', groups: ['mitglied'] } },
  refKv:       { user: { id: 'u3', groups: ['ref-finanzen-kv'] } },
  refHv:       { user: { id: 'u4', groups: ['ref-finanzen-hv'] } },
  refFin:      { user: { id: 'u5', groups: ['ref-finanzen'] } },
  admin:       { user: { id: 'u6', groups: ['admin'] } },
  itAdmin:     { user: { id: 'u7', groups: ['it-admin'] } },
  refFinKv:    { user: { id: 'u8', groups: ['ref-finanzen', 'ref-finanzen-kv'] } },
};

describe('hasGroup', () => {
  test('true when group present', () => {
    expect(makeAuthHelpers(sessions.refKv).hasGroup('ref-finanzen-kv')).toBe(true);
  });
  test('false when group absent', () => {
    expect(makeAuthHelpers(sessions.mitglied).hasGroup('admin')).toBe(false);
  });
});

describe('hasAny', () => {
  test('true when any group present', () => {
    expect(makeAuthHelpers(sessions.refKv).hasAny('admin', 'ref-finanzen-kv')).toBe(true);
  });
  test('false when none present', () => {
    expect(makeAuthHelpers(sessions.mitglied).hasAny('admin', 'it-admin')).toBe(false);
  });
  test('false for empty session groups', () => {
    expect(makeAuthHelpers(sessions.none).hasAny('admin')).toBe(false);
  });
});

describe('finance helpers degrade gracefully when the finance module is absent', () => {
  // Carve note: the finance capability ids (finance.*) are contributed by the
  // finance FEATURE MODULE. In the governance-only kernel the composed
  // CAPABILITIES map has none of them, so every finance helper resolves to
  // `false` (the capability is simply ungranted) — and crucially does NOT throw
  // on a spread of an undefined group list.
  test.each([
    'refKv', 'refHv', 'refFin', 'admin', 'itAdmin', 'refFinKv', 'mitglied', 'none',
  ] as const)('%s → all finance helpers return false (kernel CAPABILITIES is empty)', (key) => {
    const h = makeAuthHelpers(sessions[key]);
    expect(h.canApproveAny()).toBe(false);
    expect(h.canEditBudget()).toBe(false);
    expect(h.canApproveBudget()).toBe(false);
    expect(h.canConfigureFints()).toBe(false);
    expect(h.canManageSubOrgs()).toBe(false);
  });
});

describe('finance helpers light up when the finance capability map is supplied', () => {
  // Proves the helper machinery itself is intact: when a capabilities map shaped
  // like the finance module's is passed (the seam makeAuthHelpers exposes for
  // tenant-aware composition), the helpers resolve through it exactly as before.
  const FINANCE_CAPS: Record<CapabilityId, readonly string[]> = {
    'finance.approve.any':     ['ref-finanzen-hv', 'ref-finanzen-kv', 'admin'],
    'finance.budget.edit':     ['ref-finanzen', 'ref-finanzen-hv', 'admin', 'it-admin'],
    'finance.budget.approve':  ['ref-finanzen-hv', 'admin', 'it-admin'],
    'finance.fints.configure': ['it-admin', 'admin'],
    'finance.suborgs.manage':  ['ref-finanzen-hv', 'admin'],
  };

  test.each([
    ['refKv',   true],
    ['refHv',   true],
    ['admin',   true],
    ['itAdmin', false],
    ['mitglied', false],
  ] as const)('canApproveAny: %s → %s', (key, expected) => {
    expect(makeAuthHelpers(sessions[key], FINANCE_CAPS).canApproveAny()).toBe(expected);
  });

  test.each([
    ['refFin',   true],
    ['refHv',    true],
    ['admin',    true],
    ['itAdmin',  true],
    ['refKv',    false],
    ['mitglied', false],
  ] as const)('canEditBudget: %s → %s', (key, expected) => {
    expect(makeAuthHelpers(sessions[key], FINANCE_CAPS).canEditBudget()).toBe(expected);
  });

  test('refFinKv can edit budget but cannot approve budget', () => {
    const h = makeAuthHelpers(sessions.refFinKv, FINANCE_CAPS);
    expect(h.canEditBudget()).toBe(true);
    expect(h.canApproveBudget()).toBe(false);
  });
});
