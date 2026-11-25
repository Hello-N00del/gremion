// The list page of an instance without a portal: a clean 404, marked, not a 500.
import { describe, it, expect, vi } from 'vitest';
import { PortalAbsentError } from '$lib/server/portal-absent';

const db = vi.hoisted(() => ({ fail: null as unknown }));
vi.mock('$lib/server/public-db', () => ({
  getPublishedProtocols: () => (db.fail ? Promise.reject(db.fail) : Promise.resolve([])),
  getAllCommittees: () => Promise.resolve([]),
}));

import { load } from './+page.server';

const event = (locals: App.Locals) =>
  ({ url: new URL('http://127.0.0.1:3000/protokolle'), locals }) as never;
const run = (locals: App.Locals) => (load as (e: never) => Promise<unknown>)(event(locals));

describe('/protokolle without a portal', () => {
  it('answers 404 and marks the request when the portal database is absent', async () => {
    db.fail = new PortalAbsentError();
    const locals: App.Locals = {};
    const err = await run(locals).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 404 });
    expect(locals.portalAbsent).toBe(true);
  });

  it('keeps any other failure a failure (a 500 for SvelteKit)', async () => {
    const boom = new Error('connection lost');
    db.fail = boom;
    const locals: App.Locals = {};
    const err = await run(locals).catch((e: unknown) => e);
    expect(err).toBe(boom);
    expect(locals.portalAbsent).toBeUndefined();
  });

  it('still answers the list when the database is fine', async () => {
    db.fail = null;
    const out = (await run({})) as { protocols: unknown[] };
    expect(out.protocols).toEqual([]);
  });
});
