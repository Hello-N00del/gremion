// The portal of an instance that has none set up must answer a clean 404 with a
// marker, never a 500: the pieces of that answer.
import { describe, it, expect } from 'vitest';
import {
  PortalAbsentError,
  PORTAL_ABSENT_HEADER,
  PORTAL_ABSENT_VALUE,
  isPortalDatabaseAbsent,
  orNoPortal,
} from './portal-absent';

describe('isPortalDatabaseAbsent', () => {
  it('knows a missing relation and a missing database', () => {
    expect(isPortalDatabaseAbsent({ code: '42P01' })).toBe(true);
    expect(isPortalDatabaseAbsent({ code: '3D000' })).toBe(true);
  });

  it('does not take any other failure for an absent portal', () => {
    for (const code of ['28P01', '42501', '08006', '57P01', '42703', '53300']) {
      expect(isPortalDatabaseAbsent({ code })).toBe(false);
    }
    expect(isPortalDatabaseAbsent(new Error('boom'))).toBe(false);
    expect(isPortalDatabaseAbsent(null)).toBe(false);
    expect(isPortalDatabaseAbsent('42P01')).toBe(false);
  });
});

describe('orNoPortal', () => {
  it('passes a value through and leaves the locals alone', async () => {
    const locals: App.Locals = {};
    expect(await orNoPortal(locals, async () => 7)).toBe(7);
    expect(locals.portalAbsent).toBeUndefined();
  });

  it('turns an absent portal into a 404 and marks the locals', async () => {
    const locals: App.Locals = {};
    const err = await orNoPortal(locals, async () => {
      throw new PortalAbsentError();
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 404 });
    expect(locals.portalAbsent).toBe(true);
  });

  it('lets every other failure through unchanged, and does not mark the locals', async () => {
    const locals: App.Locals = {};
    const boom = new Error('connection lost');
    const err = await orNoPortal(locals, async () => {
      throw boom;
    }).catch((e: unknown) => e);
    expect(err).toBe(boom);
    expect(locals.portalAbsent).toBeUndefined();
  });

  it('names the marker header and value the CD probe reads', () => {
    expect(PORTAL_ABSENT_HEADER).toBe('x-gremion-portal');
    expect(PORTAL_ABSENT_VALUE).toBe('none');
  });
});
