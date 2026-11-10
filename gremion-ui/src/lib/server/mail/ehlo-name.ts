/**
 * The name announced in EHLO. Without it nodemailer sends the OS host name, which in a container
 * is its id, and Google's relay refuses that with 421 (EHLO). Shared by the tenant mail transport
 * and the Settings SMTP test, so the test reports what a real send would experience.
 */
export function smtpEhloName(): string | undefined {
  try {
    return new URL(process.env.PUBLIC_BASE_URL ?? '').hostname || undefined
  } catch {
    return undefined
  }
}
