// gremion-public/src/routes/kontakt/+page.server.ts
// Reads contact details from env — no DB access on this page.
// TASK-032 (TRD-410 [D R20-D5]): reads process.env directly rather than
// $env/dynamic/public — see +layout.server.ts's header comment.
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
  return {
    email: process.env.PUBLIC_CONTACT_EMAIL ?? null,
    address: process.env.PUBLIC_CONTACT_ADDRESS ?? null,
    officeHours: process.env.PUBLIC_CONTACT_OFFICE_HOURS ?? null,
    imprintResponsible: process.env.PUBLIC_IMPRINT_RESPONSIBLE ?? null,
  };
};
