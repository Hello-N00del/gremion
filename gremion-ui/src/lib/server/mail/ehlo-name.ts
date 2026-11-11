let warned = false

/**
 * The name announced in EHLO. Without it nodemailer sends the OS host name, which in a container
 * is its id, and Google's relay refuses that with 421 (EHLO). Shared by the tenant mail transport
 * and the Settings SMTP test, so the test reports what a real send would experience.
 *
 * When PUBLIC_BASE_URL is unset or not a URL the OS host name is used after all, so that is said
 * once per process (the setting's name only, never its value).
 */
export function smtpEhloName(): string | undefined {
  try {
    const host = new URL(process.env.PUBLIC_BASE_URL ?? '').hostname
    if (host) return host
  } catch {
    // fall through to the warning below
  }
  if (!warned) {
    warned = true
    console.warn('[mail] PUBLIC_BASE_URL is unset or not a URL; the SMTP EHLO name falls back to the OS host name, which some relays refuse.')
  }
  return undefined
}
