import { describe, expect, it } from 'vitest';
import { GET } from './+server';

// TASK-023: the portal's tenant-blind liveness marker. It is served at
// ${PUBLIC_BASE_PATH}/healthz because kit.paths.base prefixes every route, which
// is the path gremion-switch renders into active.yml for public/public-next.
describe('GET /healthz (gremion-public)', () => {
  it('answers 200 with exactly {"ok":true,"app":"gremion-public"}', async () => {
    const res = (await GET({} as never)) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('{"ok":true,"app":"gremion-public"}');
  });

  it('is byte-identical across probes', async () => {
    const a = await ((await GET({} as never)) as Response).text();
    const b = await ((await GET({} as never)) as Response).text();
    expect(a).toBe(b);
  });
});
