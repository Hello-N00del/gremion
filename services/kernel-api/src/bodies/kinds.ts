// services/kernel-api/src/bodies/kinds.ts -- the vendor-default org unit kind
// catalogue (DOMAIN DB-IDT-ORGUNITKIND), as DATA seeded per customer by the
// migrate hook (never code, PRD-PLAT-006).
//
// Body kinds: the six of DOMAIN s.DB-IDT-BODY (SCHEMA :3331). Unit kinds: the
// kinds the stura vertical's blueprint uses (verticals/stura/blueprint.json
// orgUnits[].kind); test/bodies/kinds.test.ts holds the two equal, so a vertical
// that gains a kind without a catalogue row fails here, and a unit of a kind the
// catalogue does not hold is refused at the write (Q8: unmapped kind refuses).
//
// [A] flags the decisions the DOMAIN text leaves to the operator:
//   * initiative: level body, may_adopt_beschluesse stays 'undecided' (question 4);
//   * unit kinds: 'council' may adopt Beschluesse, committee / group stay 'undecided'.

export interface KindSeed {
  kindKey: string
  level: 'body' | 'unit'
  labelDe: string
  labelEn: string
  isOrgan: boolean
  canHoldSeats: boolean
  mayAdoptBeschluesse: 'yes' | 'no' | 'undecided'
  allowedParentKinds: readonly string[]
}

export const VENDOR_BODY_KINDS: readonly KindSeed[] = [
  { kindKey: 'stura', level: 'body', labelDe: 'Studierendenrat', labelEn: 'Student council', isOrgan: false, canHoldSeats: true, mayAdoptBeschluesse: 'yes', allowedParentKinds: [] },
  { kindKey: 'stupa', level: 'body', labelDe: 'Studierendenparlament', labelEn: 'Student parliament', isOrgan: false, canHoldSeats: true, mayAdoptBeschluesse: 'yes', allowedParentKinds: [] },
  { kindKey: 'fachschaftsrat', level: 'body', labelDe: 'Fachschaftsrat', labelEn: 'Department student council', isOrgan: false, canHoldSeats: true, mayAdoptBeschluesse: 'yes', allowedParentKinds: ['stura', 'stupa'] },
  { kindKey: 'referat', level: 'body', labelDe: 'Referat', labelEn: 'Portfolio office', isOrgan: false, canHoldSeats: true, mayAdoptBeschluesse: 'no', allowedParentKinds: ['stura', 'stupa'] },
  { kindKey: 'initiative', level: 'body', labelDe: 'Initiative', labelEn: 'Initiative', isOrgan: false, canHoldSeats: true, mayAdoptBeschluesse: 'undecided', allowedParentKinds: ['stura', 'stupa'] },
  { kindKey: 'verwaltung', level: 'body', labelDe: 'Verwaltung', labelEn: 'Administration', isOrgan: false, canHoldSeats: true, mayAdoptBeschluesse: 'no', allowedParentKinds: [] },
]

export const VERTICAL_UNIT_KINDS: readonly KindSeed[] = [
  { kindKey: 'council', level: 'unit', labelDe: 'Rat', labelEn: 'Council', isOrgan: true, canHoldSeats: true, mayAdoptBeschluesse: 'yes', allowedParentKinds: [] },
  { kindKey: 'committee', level: 'unit', labelDe: 'Ausschuss', labelEn: 'Committee', isOrgan: true, canHoldSeats: true, mayAdoptBeschluesse: 'undecided', allowedParentKinds: ['council', 'committee'] },
  { kindKey: 'group', level: 'unit', labelDe: 'Gruppe', labelEn: 'Group', isOrgan: false, canHoldSeats: false, mayAdoptBeschluesse: 'undecided', allowedParentKinds: ['council', 'committee', 'group'] },
]

export const VENDOR_KINDS: readonly KindSeed[] = [...VENDOR_BODY_KINDS, ...VERTICAL_UNIT_KINDS]
