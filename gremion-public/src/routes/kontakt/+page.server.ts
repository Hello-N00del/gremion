// gremion-public/src/routes/kontakt/+page.server.ts
// Reads contact details from env — no DB access on this page.
import type { PageServerLoad } from './$types';
import { env } from '$env/dynamic/public';

export const load: PageServerLoad = () => {
  return {
    email: env.PUBLIC_CONTACT_EMAIL ?? null,
    address: env.PUBLIC_CONTACT_ADDRESS ?? null,
    officeHours: env.PUBLIC_CONTACT_OFFICE_HOURS ?? null,
    imprintResponsible: env.PUBLIC_IMPRINT_RESPONSIBLE ?? null,
  };
};
