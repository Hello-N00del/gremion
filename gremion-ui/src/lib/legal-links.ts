// R27-SIGNIN-LEGAL-K: the three legal routes gremion-ui serves publicly
// (hooks.server.ts `publicPaths` includes '/legal/', so these are reachable
// without a session). Single source for the href list so consumers that
// link to them -- the sidebar's LegalMenu and the sign-in page's footer --
// cannot drift out of sync.
export const LEGAL_HREFS = {
  impressum: '/legal/impressum',
  datenschutz: '/legal/datenschutz',
  barrierefreiheit: '/legal/barrierefreiheit'
} as const
