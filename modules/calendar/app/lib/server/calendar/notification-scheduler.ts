import cron from 'node-cron'
import { forEachActiveTenant } from '$lib/server/tenant/worker-fleet'
import { getTenant } from '$lib/server/tenant/context'
import { getTenantMailContext } from '$lib/server/mail/tenant-mail'
import { listDueNotifications, markNotificationSent, markNotificationFailed } from '../governance/governance-db'
import type { ScheduledNotification } from '../governance/governance-db'

export interface EmailSender {
  sendEmail(to: string, subject: string, body: string): Promise<void>
}

const SUBJECTS: Record<ScheduledNotification['type'], string> = {
  term_reminder: 'StuRaOS: Term expiry reminder',
  grace_start: 'StuRaOS: Term has expired — grace period started',
  grace_expiry: 'StuRaOS: Grace period ending — access will be revoked'
}

export async function processDueNotifications(sender: EmailSender): Promise<void> {
  const due = await listDueNotifications()

  for (const notification of due) {
    // sendEmail and markNotificationSent are handled in separate try/catch
    // blocks: they fail in different ways and must not be conflated. If
    // sendEmail itself throws, nothing was delivered — that is a genuine send
    // failure. If sendEmail resolves but markNotificationSent then throws
    // (e.g. a transient DB error), the email WAS delivered; treating that as
    // a send failure would misreport it in the log and, worse, permanently
    // mark as failed a notification the recipient already received.
    try {
      await sender.sendEmail(
        notification.recipient_keycloak_id,
        SUBJECTS[notification.type],
        `Notification type: ${notification.type} for assignment ${notification.role_assignment_id}`
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Make the failure visible. listDueNotifications() filters on
      // `failed_at IS NULL`, so marking a notification failed removes it from
      // the queue for good — without a log line the only trace of a permanently
      // undelivered term/grace notification was a DB column nobody reads.
      console.error(
        `[notification-scheduler] ${notification.type} notification ${notification.id} ` +
          `(assignment ${notification.role_assignment_id}) failed to send: ${message}`
      )
      try {
        await markNotificationFailed(notification.id, message)
      } catch (persistErr) {
        // Losing the reason must neither be silent nor abort the rest of the
        // batch: an unhandled throw here would skip every remaining due
        // notification for this tenant on this tick.
        const persistMessage = persistErr instanceof Error ? persistErr.message : String(persistErr)
        console.error(
          `[notification-scheduler] ${notification.type} notification ${notification.id} ` +
            `(assignment ${notification.role_assignment_id}) could not persist failure_reason: ${persistMessage}`
        )
      }
      continue
    }

    try {
      await markNotificationSent(notification.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // The email was already sent, so this must stay retryable rather than
      // permanently failed: at-least-once delivery (a possible duplicate
      // reminder on the next tick) is the safer failure mode than silently
      // dropping a notification whose email the recipient already got.
      console.error(
        `[notification-scheduler] ${notification.type} notification ${notification.id} ` +
          `(assignment ${notification.role_assignment_id}) sent, but could not record sent_at: ${message} ` +
          `— it may be sent again on the next tick`
      )
    }
  }
}

let _started = false

/** Start the weekly cron job. Call once from hooks.server.ts. */
export function startNotificationScheduler(): void {
  if (_started) return
  _started = true
  // Every Monday at 07:00.
  // P2.1b T4: every tick drains the due notifications per ACTIVE tenant inside
  // that tenant's explicit runWithTenant scope — forEachActiveTenant provides
  // per-(worker, tenant) single-flight + per-tenant try/catch + structured log.
  // SP-2 §2.5: the sender is now resolved PER TENANT at tick time from the mail
  // seam (was a boot-injected default-tenant transport). Every active tenant with
  // its own configured SMTP sends from ITS identity; an unconfigured tenant is
  // skipped (logged per tick, with its slug) instead of riding tenant-1's transport.
  cron.schedule('0 7 * * 1', () =>
    forEachActiveTenant('notification-scheduler', async () => {
      const mail = getTenantMailContext()
      if (!mail.configured) {
        console.info(`[notification-scheduler] tenant ${getTenant().slug} SMTP not configured — skipping tick`)
        return
      }
      await processDueNotifications({
        sendEmail: (to, subject, body) =>
          mail.transport.sendMail({ from: mail.from, to, subject, text: body }).then(() => void 0),
      })
    }),
  )
}
