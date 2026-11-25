// When does the DB layer say "this instance has no portal"? Only when the portal
// database was not named explicitly AND it lacks the portal tables (or does not
// exist). A named database that fails, and any other failure, stay failures.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const envState = vi.hoisted(() => ({
  GREMION_PUBLIC_DB_URL: 'postgres://mock:mock@localhost/mock',
} as Record<string, string | undefined>));
vi.mock('$env/dynamic/private', () => ({ env: envState }));

const mockState = vi.hoisted(() => ({ failWith: null as unknown }));
vi.mock('postgres', () => {
  const sql = Object.assign(
    () => (mockState.failWith ? Promise.reject(mockState.failWith) : Promise.resolve([])),
    { unsafe: () => Promise.resolve([]), end: () => Promise.resolve() }
  );
  return { default: () => sql };
});

import { getAllCommittees, getPublishedProtocols, getPublishedProtocolById } from './public-db.js';
import { PortalAbsentError } from './portal-absent';

const UUID = '00000000-0000-4000-8000-000000000000';
const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

describe('portal database absent', () => {
  beforeEach(() => {
    mockState.failWith = null;
    delete envState.PORTAL_DB_EXPLICIT;
  });

  it.each([
    ['getPublishedProtocols', () => getPublishedProtocols()],
    ['getPublishedProtocolById', () => getPublishedProtocolById(UUID)],
    ['getAllCommittees', () => getAllCommittees()],
  ])('%s: a missing relation without a named portal database is PortalAbsentError', async (_n, call) => {
    mockState.failWith = pgError('42P01');
    await expect(call()).rejects.toBeInstanceOf(PortalAbsentError);
  });

  it('a missing database without a named portal database is PortalAbsentError', async () => {
    mockState.failWith = pgError('3D000');
    await expect(getPublishedProtocols()).rejects.toBeInstanceOf(PortalAbsentError);
  });

  it('a portal database that IS named and fails the same way stays the original failure', async () => {
    envState.PORTAL_DB_EXPLICIT = '1';
    mockState.failWith = pgError('42P01');
    const err = await getPublishedProtocols().catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(PortalAbsentError);
    expect(err).toBe(mockState.failWith);
  });

  it('any other failure stays the original failure', async () => {
    mockState.failWith = pgError('28P01');
    const err = await getPublishedProtocols().catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(PortalAbsentError);
    expect(err).toBe(mockState.failWith);
  });
});
