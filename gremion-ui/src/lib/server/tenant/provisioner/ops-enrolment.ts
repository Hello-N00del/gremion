// Operator enrolment for the ops realm (`gremion-tenant operator add --no-mail`).
//
// The control panel and the ops dashboards always sign in at loa2, and the realm's step-up
// flow is OTP-or-deny (it must never enrol an authenticator inside the step-up).
// A new operator -- UPDATE_PASSWORD + CONFIGURE_TOTP pending, no OTP credential
// yet -- is therefore refused at the panel until the required actions have run.
// They run on any plain (loa1) sign-in: the platform realm's account console.
//
// Wording: the TRD-199 scan (compose/observability/trd199.test.mjs) reads all of
// gremion-ui/src as member-facing source and keeps it free of any mention of the
// ops dashboards by product name, so this operator-only text says "ops dashboards".

/** The account console of the platform (ops) realm, or a placeholder naming the issuer. */
export function opsAccountConsoleUrl(platformDomain: string | undefined): string {
  const d = (platformDomain ?? '').trim()
  return d ? `https://${d}/auth/realms/platform/account` : '<PANEL_OIDC_ISSUER>/account'
}

/** The log line `operator add --no-mail` prints after creating the operator. */
export function opsOperatorEnrolmentNotice(email: string, platformDomain: string | undefined): string {
  return (
    `operator ${email} created with a temporary password (Q23: no vendor mail on this host). ` +
    `Enrol FIRST at the account console ${opsAccountConsoleUrl(platformDomain)}: ` +
    `that plain sign-in sets the new password and configures TOTP. ` +
    `The control panel and the ops dashboards require loa2 (password + TOTP) and refuse an operator without TOTP, so they cannot be used for enrolment`
  )
}
