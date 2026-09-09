import { describe, it, expect, vi, beforeEach } from 'vitest';

// The route reads PUBLIC_MAIN_APP_URL from `$env/dynamic/public` — the private
// dynamic env filters out PUBLIC_-prefixed names, so mocking `private` here (as
// this test used to) mocked a module the route never consults.
vi.mock('$env/dynamic/public', () => ({
  env: { PUBLIC_MAIN_APP_URL: 'https://example.org' },
}));

const { mockGetById } = vi.hoisted(() => ({ mockGetById: vi.fn() }));
vi.mock('$lib/server/public-db', () => ({
  getPublishedProtocolById: mockGetById,
}));

import { GET } from './+server';

const VALID_ID = '11111111-1111-4111-8111-111111111111';

function call(id: string) {
  // @ts-expect-error partial event — the route only reads params.id
  return GET({ params: { id } });
}

describe('GET /api/public/protocols/[id]/pdf (#241 — gremion-public redirects, holds no NC creds)', () => {
  beforeEach(() => mockGetById.mockReset());

  it('404s when the protocol is not found', async () => {
    mockGetById.mockResolvedValue(null);
    await expect(call(VALID_ID)).rejects.toMatchObject({ status: 404 });
  });

  it('404s when the protocol has no stored PDF path', async () => {
    mockGetById.mockResolvedValue({ id: VALID_ID, pdf_nextcloud_path: null });
    await expect(call(VALID_ID)).rejects.toMatchObject({ status: 404 });
  });

  it('redirects (302) to the main app PDF route — no WebDAV, no credentials', async () => {
    mockGetById.mockResolvedValue({
      id: VALID_ID,
      pdf_nextcloud_path: `/protocols/published/${VALID_ID}/protocol.pdf`,
    });
    await expect(call(VALID_ID)).rejects.toMatchObject({
      status: 302,
      location: `https://example.org/api/public/protocols/${VALID_ID}/pdf`,
    });
  });
});
