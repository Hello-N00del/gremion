// gremion-public/src/routes/beschluesse/+page.server.ts
// Public Beschluss register (#320) — anonymous, mirrors protokolle/+page.server.ts.
import type { PageServerLoad } from './$types';
import { getPublicBeschluesse, getAllCommittees } from '$lib/server/public-db';
import { isUuid } from '$lib/validate';

export const load: PageServerLoad = async ({ url }) => {
  const committeeParam = url.searchParams.get('ausschuss')?.trim();
  // #262 D5: only forward `ausschuss` when it is a valid UUID — a non-UUID value
  // would otherwise reach `${committeeId}::uuid` and 500 with "invalid input
  // syntax for type uuid". A garbage filter degrades to "no filter".
  const committeeId = committeeParam && isUuid(committeeParam) ? committeeParam : undefined;

  const [beschluesse, committees] = await Promise.all([
    getPublicBeschluesse(committeeId),
    getAllCommittees(),
  ]);

  return { beschluesse, committees, selectedCommitteeId: committeeId ?? null };
};
