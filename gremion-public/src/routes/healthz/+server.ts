import type { RequestHandler } from './$types';

/**
 * GET ${PUBLIC_BASE_PATH}/healthz — the portal's liveness marker (TASK-023).
 *
 * Tenant-blind on purpose (a written residual of spec B §1.6(a)): the portal
 * has no tenant resolver, so there is no slug to report. It touches no
 * database, so the container healthcheck and Traefik's public/public-next
 * probes stay green while Postgres is briefly away. kit.paths.base prefixes the
 * route, which is why gremion-switch substitutes PUBLIC_BASE_PATH into the
 * probe path.
 */
const BODY = JSON.stringify({ ok: true, app: 'gremion-public' });

export const GET: RequestHandler = () =>
  new Response(BODY, {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
