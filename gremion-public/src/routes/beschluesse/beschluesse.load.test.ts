// #320 — public Beschluss register (/beschluesse). Drives the route's load
// directly with a partial event ({ url }) and mocks the public-db module,
// mirroring antrag.action.test.ts's route-test style. Pins:
//   1. a valid-UUID ?ausschuss= is forwarded to getPublicBeschluesse and echoed
//      back as selectedCommitteeId;
//   2. a non-UUID ?ausschuss= degrades to "no filter" (isUuid guard, #262 D5 —
//      same rule as protokolle/+page.server.ts);
//   3. an acclamation row with NULL tallies crosses load unmangled — the nulls
//      stay null (never NaN, never 0-coerced), so the page can render
//      'per Akklamation' instead of a fake 0:0:0 tally.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PublicBeschluss, PublicCommittee } from '@gremion/db/public-types';

const { mockGetPublicBeschluesse, mockGetAllCommittees } = vi.hoisted(() => ({
  mockGetPublicBeschluesse: vi.fn(),
  mockGetAllCommittees: vi.fn(),
}));
vi.mock('$lib/server/public-db', () => ({
  getPublicBeschluesse: mockGetPublicBeschluesse,
  getAllCommittees: mockGetAllCommittees,
}));

import { load } from './+page.server';

const COMMITTEE_ID = '0b8f6c3a-9d2e-4f10-8a5b-6c7d8e9f0a1b';

const COMMITTEE: PublicCommittee = {
  id: COMMITTEE_ID,
  name: 'Haushaltsausschuss',
  description: null,
  parent_id: null,
  created_at: new Date('2026-01-05T10:00:00Z'),
};

const TALLY_ROW: PublicBeschluss = {
  id: 'c0ffee00-1111-4222-8333-444455556666',
  protocol_id: 'aaaabbbb-cccc-4ddd-8eee-ffff00001111',
  global_nr: 'B-2026-042',
  sequence_nr: 2,
  text: 'Das Plenum beschließt die Förderung des Kulturfests.',
  votes_yes: 7,
  votes_no: 1,
  votes_abstain: 2,
  adoption_mode: 'tally',
  meeting_date: new Date('2026-06-11T00:00:00Z'),
  protocol_title: 'Sitzung 2026-06-11',
  committee_id: COMMITTEE_ID,
  committee_name: 'Haushaltsausschuss',
  result: 'passed',
  decided_at: new Date('2026-06-11T18:30:00Z'),
  angefochten_count: 0,
};

// Migration 054 vote/mode matrix: an acclamation Beschluss may carry NO tally —
// all three counts NULL, which is semantically "unrecorded", not zero.
const ACCLAMATION_ROW: PublicBeschluss = {
  ...TALLY_ROW,
  id: 'deadbeef-2222-4333-8444-555566667777',
  global_nr: 'B-2026-043',
  sequence_nr: 3,
  text: 'Die Tagesordnung wird per Akklamation angenommen.',
  votes_yes: null,
  votes_no: null,
  votes_abstain: null,
  adoption_mode: 'acclamation',
  angefochten_count: 1,
};

async function call(search = '') {
  const url = new URL(`http://localhost/beschluesse${search}`);
  // @ts-expect-error partial event — the load only reads url
  const result = await load({ url });
  // PageServerLoad's signature admits void; this load always returns data.
  if (!result) throw new Error('load returned no data');
  return result;
}

describe('/beschluesse load (public Beschluss register)', () => {
  beforeEach(() => {
    mockGetPublicBeschluesse.mockReset().mockResolvedValue([TALLY_ROW]);
    mockGetAllCommittees.mockReset().mockResolvedValue([COMMITTEE]);
  });

  it('forwards a valid-UUID ausschuss param and echoes it as selectedCommitteeId', async () => {
    const result = await call(`?ausschuss=${COMMITTEE_ID}`);
    expect(mockGetPublicBeschluesse).toHaveBeenCalledTimes(1);
    expect(mockGetPublicBeschluesse).toHaveBeenCalledWith(COMMITTEE_ID);
    expect(result).toEqual({
      beschluesse: [TALLY_ROW],
      committees: [COMMITTEE],
      selectedCommitteeId: COMMITTEE_ID,
    });
  });

  it('degrades a non-UUID ausschuss param to "no filter" (#262 D5)', async () => {
    const result = await call('?ausschuss=not-a-uuid');
    expect(mockGetPublicBeschluesse).toHaveBeenCalledTimes(1);
    // No filter reaches the DB layer — a garbage param must never hit a
    // `::uuid` cast and 500 the anonymous route.
    expect(mockGetPublicBeschluesse).toHaveBeenCalledWith(undefined);
    expect(result.selectedCommitteeId).toBeNull();
    expect(result.beschluesse).toEqual([TALLY_ROW]);
  });

  it('passes an acclamation row with NULL tallies through load unmangled', async () => {
    mockGetPublicBeschluesse.mockResolvedValue([ACCLAMATION_ROW]);
    const result = await call();
    expect(result.beschluesse).toHaveLength(1);
    const row = result.beschluesse[0];
    // Deep-equal against the fixture: no field dropped, renamed, or rewritten.
    expect(row).toEqual(ACCLAMATION_ROW);
    // The three tallies stay strictly null — toBeNull rejects 0, NaN, and
    // undefined alike, so any "helpful" numeric coercion in load fails here.
    expect(row.votes_yes).toBeNull();
    expect(row.votes_no).toBeNull();
    expect(row.votes_abstain).toBeNull();
    expect(row.adoption_mode).toBe('acclamation');
    expect(row.angefochten_count).toBe(1);
  });

  it('source guard: the route is anonymous and the Anfechtung badge is count-only', () => {
    const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
    const server = readFileSync(here('./+page.server.ts'), 'utf8');
    const page = readFileSync(here('./+page.svelte'), 'utf8');
    // Anonymous surface: the load never reads locals (no session/identity
    // access anywhere in the route folder).
    expect(server).not.toContain('locals');
    expect(page).not.toContain('locals');
    // The Anfechtung badge renders from the bare count alone — the projection
    // carries no challenger identity for it to leak.
    expect(page).toContain('angefochten_count');
  });
});
