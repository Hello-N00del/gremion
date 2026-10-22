// services/kernel-api/src/authz/catalogue.ts — the closed, versioned authz
// catalogue (TASK-081 brief s.5.2): the roles and capabilities a customer's
// kernel database is synced to. Role-to-capability sets live HERE and nowhere
// else; the scan (test/authz/no-role-check.test.ts) keeps role comparisons out
// of the rest of src/**.
//
// Key shape: DOMAIN's literal name where it has one (newsletter.send), else
// <owning context>.<action> [A]. module_key resolves the owning module; kernel
// capabilities (idt.*) belong to no module and decide without a module test.

export const CATALOGUE_VERSION = '1.0.0'

export interface CapabilityDef {
  key: string
  /** The module that owns it (plt.module.module_key), or null for a kernel (idt.*) capability. */
  moduleKey: string | null
  privileged: boolean
  resourceKind?: string
}

export interface RoleDef {
  key: string
  labelDe: string
  labelEn: string
  scopeLevel: 'body' | 'customer'
  privileged: boolean
  capabilities: readonly string[]
  /**
   * TRD-113/TRD-091 role inclusion: which roles a holder of this role may grant.
   * 'body' = the body-level roles, 'all' = every role, 'none' = none. Capabilities are
   * grantable when a grantable role carries them.
   */
  grants: 'body' | 'all' | 'none'
}

const cap = (key: string, moduleKey: string | null, o: { privileged?: boolean; resourceKind?: string } = {}): CapabilityDef =>
  ({ key, moduleKey, privileged: o.privileged ?? false, ...(o.resourceKind ? { resourceKind: o.resourceKind } : {}) })

export const CAPABILITIES: readonly CapabilityDef[] = Object.freeze([
  cap('idt.grant.manage', null, { privileged: true }),
  cap('idt.grant.read', null),
  cap('idt.body.read', null),
  cap('gov.nonpublic.read', 'votes'),
  cap('gov.agenda_item.propose', 'votes'),
  cap('gov.motion.propose', 'votes'),
  cap('gov.vote.cast', 'votes'),
  cap('gov.quorum.count', 'votes'),
  cap('gov.office.hold', 'votes'),
  cap('gov.portfolio.hold', 'votes'),
  cap('gov.protocol.take', 'votes', { resourceKind: 'meeting' }),
  cap('gov.meeting.chair', 'votes', { resourceKind: 'meeting' }),
  cap('brd.card.own', 'board'),
  cap('brd.card.be_assigned', 'board'),
  cap('brd.board.administer', 'board'),
  cap('cal.event.manage', 'calendar'),
  cap('fin.expense.approve', 'finance', { privileged: true }),
  cap('fin.ledger.read', 'finance'),
  cap('newsletter.send', 'publishing'),
])

const MEMBER = [
  'gov.nonpublic.read', 'gov.agenda_item.propose', 'gov.motion.propose', 'brd.card.own', 'brd.card.be_assigned',
  'gov.vote.cast', 'gov.quorum.count', 'gov.office.hold', 'gov.portfolio.hold',
] as const
/** [D R22-7, R22-15] helper = member minus vote, quorum, office, portfolio (TRD-116). */
const HELPER = MEMBER.slice(0, 5)

const role = (key: string, labelDe: string, labelEn: string, capabilities: readonly string[], o: { privileged?: boolean; scopeLevel?: 'body' | 'customer'; grants?: 'body' | 'all' | 'none' } = {}): RoleDef =>
  ({ key, labelDe, labelEn, scopeLevel: o.scopeLevel ?? 'body', privileged: o.privileged ?? false, capabilities, grants: o.grants ?? 'none' })

export const ROLES: readonly RoleDef[] = Object.freeze([
  role('member', 'Mitglied', 'Member', MEMBER),
  role('helper', 'Helfer:in', 'Helper', HELPER),
  role('chair', 'Vorsitz', 'Chair', ['gov.meeting.chair', 'gov.nonpublic.read']),
  role('protocol_taker', 'Protokollant:in', 'Protocol taker', ['gov.protocol.take', 'gov.nonpublic.read']),
  role('body_admin', 'Gremienadmin', 'Body admin', ['idt.grant.manage', 'idt.grant.read', 'idt.body.read', 'brd.board.administer'], { privileged: true, grants: 'body' }),
  role('council_admin', 'Rats-Admin', 'Council admin', ['idt.grant.manage', 'idt.grant.read', 'idt.body.read', 'cal.event.manage', 'brd.board.administer'], { privileged: true, scopeLevel: 'customer', grants: 'all' }),
  role('it_admin', 'IT-Admin', 'IT admin', ['idt.grant.manage', 'idt.grant.read', 'idt.body.read'], { privileged: true, scopeLevel: 'customer', grants: 'body' }),
  role('marketing', 'Oeffentlichkeitsarbeit', 'Marketing', ['newsletter.send']),
  role('finance', 'Finanzen', 'Finance', ['fin.expense.approve', 'fin.ledger.read'], { privileged: true, scopeLevel: 'customer' }),
  role('initiative_lead', 'Initiativenleitung', 'Initiative lead', ['brd.card.own', 'brd.card.be_assigned']),
  role('initiative_member', 'Initiativenmitglied', 'Initiative member', ['brd.card.be_assigned']),
  role('auditor', 'Revision', 'Auditor', ['fin.ledger.read', 'idt.grant.read'], { privileged: true, scopeLevel: 'customer' }),
])

const CAP_BY_KEY = new Map(CAPABILITIES.map((c) => [c.key, c]))
const ROLE_BY_KEY = new Map(ROLES.map((r) => [r.key, r]))

export const capabilityDef = (key: string): CapabilityDef | undefined => CAP_BY_KEY.get(key)
export const roleDef = (key: string): RoleDef | undefined => ROLE_BY_KEY.get(key)
/**
 * TRD-113/TRD-091: does the role the granter acts under include the role or capability being granted?
 * The decision lives here with the role-to-capability sets; grants.ts never compares a role key.
 */
export function roleIncludes(granterRole: string, grantKind: 'role' | 'capability', key: string): boolean {
  const g = ROLE_BY_KEY.get(granterRole)
  if (!g || g.grants === 'none') return false
  const grantable = ROLES.filter((r) => g.grants === 'all' || r.scopeLevel === 'body')
  return grantKind === 'role' ? grantable.some((r) => r.key === key) : grantable.some((r) => r.capabilities.includes(key))
}
export const isPrivilegedRole = (key: string): boolean => ROLE_BY_KEY.get(key)?.privileged ?? false
export const isPrivilegedCapability = (key: string): boolean => CAP_BY_KEY.get(key)?.privileged ?? false
export const moduleOfCapability = (key: string): string | null | undefined => CAP_BY_KEY.get(key)?.moduleKey

/** Every module key the catalogue names (what the sweep watches for enabled -> disabled). */
export const CATALOGUE_MODULE_KEYS: readonly string[] = Object.freeze([...new Set(CAPABILITIES.flatMap((c) => (c.moduleKey ? [c.moduleKey] : [])))].sort())

// finance never carries newsletter.send (PRD-IDN-007, PRD-PUB-002); a load-time check
// so a catalogue edit cannot ship it (the database CHECK role_finance_check is the second guard).
if (ROLE_BY_KEY.get('finance')?.capabilities.includes('newsletter.send')) throw new Error('authz catalogue: finance must never carry newsletter.send')
for (const r of ROLES) for (const k of r.capabilities) if (!CAP_BY_KEY.has(k)) throw new Error(`authz catalogue: role ${r.key} names unknown capability ${k}`)
