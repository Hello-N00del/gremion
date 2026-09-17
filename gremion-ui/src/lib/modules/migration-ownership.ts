// The three kernel-block migrations that create or alter a MODULE-owned table
// and stay kernel-applied by written rule (spec B, migrations chapter §4).
// A vertical that runs calendar, elections or board OFF still gets these files:
// later ungated kernel DDL (010_org_units.sql's ALTER of committee_elections,
// 058_public_reader_grants.sql's portal_tables abort) depends on them existing.
export const CROSS_CUTTING_MODULE_TABLES = [
  'calendar_events',
  'committee_elections',
  'deck_board',
] as const

/** kernel-block migration basename -> the module table it owns. */
export const CROSS_CUTTING_MIGRATIONS: Readonly<Record<string, string>> = {
  '003_calendar_schema.sql': 'calendar_events',
  '004_committee_elections.sql': 'committee_elections',
  '034_deck_board.sql': 'deck_board',
}
