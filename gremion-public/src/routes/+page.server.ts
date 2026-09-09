// gremion-public/src/routes/+page.server.ts
import type { PageServerLoad } from './$types';
import { env } from '$env/dynamic/public';
import {
  getPublishedProtocols,
  getAllCommittees,
} from '$lib/server/public-db';

// v5 Task 4.8 — the #antrag portal section is optional. The portal-admin
// (gremion-ui) decides its visibility; gremion-public has no shared config
// read, so the operator mirrors that choice via an env flag. It defaults ON so
// a fresh deploy shows the full portal; set PUBLIC_PORTAL_ANTRAG=false to hide
// it.
//
// The sibling public budget section was REMOVED (kernel carve): it was a
// prototype section frame with no data behind it — no budget table, only a
// "PDF not yet supplied" placeholder — and public budget presentation belongs
// to the finance feature module, not to a governance-only kernel's public
// portal. Its two `PUBLIC_PORTAL_BUDGET` / `PUBLIC_BUDGET_PDF_URL` env flags
// went with it; if you still have them set in `.env`, they are inert.
// Enforced by src/lib/test/kernel-instance-leak.test.ts.
function flag(value: string | undefined, fallback = true): boolean {
  if (value == null) return fallback;
  return value !== 'false' && value !== '0';
}

export const load: PageServerLoad = async () => {
  const [latestProtocols, committees] = await Promise.all([
    getPublishedProtocols(undefined, 6),
    // Org structure for the OrganisationTree section. getAllCommittees()
    // already returns the GDPR-safe public projection (no Keycloak IDs).
    getAllCommittees().catch(() => []),
  ]);

  return {
    latestProtocols,
    committees,
    showAntrag: flag(env.PUBLIC_PORTAL_ANTRAG),
    contactEmail: env.PUBLIC_CONTACT_EMAIL ?? null,
  };
};
