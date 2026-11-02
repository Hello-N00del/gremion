// src/lib/server/module-karenz/mail.ts
// Module Karenz (phase 2, Task 9): the text of the info mail (sent at switch-off) and of its two
// reminders (day 23 and day 29). Pure functions, no I/O.
//
// The mail NEVER names the person who switched the module off. That is a property of the type, not of
// the template: KarenzMailInput has no field that could carry a person, so no caller can pass one in.
// The actor lives only in audit_log and in module_switch_request (plan Global Constraints).
//
// Dates are shown in Europe/Berlin: a council reads "30 days" as calendar days of its own clock, and a
// final day of 23:30 UTC is already the next day there.
import type { NoticeKind } from './store'

export type { NoticeKind }

export interface KarenzMailInput {
  /** What the council calls the module (its own status label), e.g. "Abstimmungen". */
  moduleLabel: string
  switchedOffAt: Date
  /** The final deletion date: the end of the 30 days. */
  finalAt: Date
  kind: NoticeKind
  /** Absolute link to the settings page where switching on again is done. */
  settingsUrl: string
}

const DAY_MS = 24 * 3_600_000
const TIME_ZONE = 'Europe/Berlin'

/** Days before the final day on which a reminder is due. */
const REMINDER_LEAD_DAYS = { t23: 7, t29: 1 } as const

/** When a reminder is due: `finalAt` minus 7 days (day 23) or minus 1 day (day 29). */
export function reminderDue(kind: 't23' | 't29', finalAt: Date): Date {
  return new Date(finalAt.getTime() - REMINDER_LEAD_DAYS[kind] * DAY_MS)
}

const deDate = new Intl.DateTimeFormat('de-DE', { timeZone: TIME_ZONE, dateStyle: 'long' })
const enDate = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, dateStyle: 'long' })

/** HTML text and attribute escaping: the label and the link are data, never markup. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** The subject and the HTML body, German first, English below. */
export function renderKarenzMail(i: KarenzMailInput): { subject: string; html: string } {
  const label = i.moduleLabel
  const finalDe = deDate.format(i.finalAt)
  const finalEn = enDate.format(i.finalAt)
  const offDe = deDate.format(i.switchedOffAt)
  const offEn = enDate.format(i.switchedOffAt)

  const subject =
    i.kind === 'switchoff'
      ? `Modul ${label} ausgeschaltet: endgültige Löschung am ${finalDe} / Module ${label} switched off: final deletion on ${finalEn}`
      : i.kind === 't23'
        ? `Erinnerung: Modul ${label} wird am ${finalDe} endgültig gelöscht / Reminder: module ${label} is deleted for good on ${finalEn}`
        : // no "tomorrow": a catch-up after an outage can send this on the day itself; the date is always right
          `Letzte Erinnerung: Modul ${label} wird am ${finalDe} endgültig gelöscht / Final reminder: module ${label} is deleted for good on ${finalEn}`

  const leadDe =
    i.kind === 'switchoff'
      ? `Das Modul <strong>${esc(label)}</strong> wurde am ${offDe} ausgeschaltet.`
      : `Zur Erinnerung: Das Modul <strong>${esc(label)}</strong> wurde am ${offDe} ausgeschaltet.`
  const leadEn =
    i.kind === 'switchoff'
      ? `The module <strong>${esc(label)}</strong> was switched off on ${offEn}.`
      : `As a reminder: the module <strong>${esc(label)}</strong> was switched off on ${offEn}.`

  const url = esc(i.settingsUrl)
  const html = [
    '<div style="font-family: sans-serif; line-height: 1.5; max-width: 40rem;">',
    '<p>',
    leadDe,
    ` Seine Daten bleiben 30 Tage lang erhalten, aber gesperrt. Am <strong>${finalDe}</strong> werden sie endgültig gelöscht.`,
    '</p>',
    '<p>Wird das Modul vor diesem Tag wieder eingeschaltet, ist alles wieder da, wie es war: die Daten, die Einstellungen und die laufenden Vorgänge.</p>',
    `<p><a href="${url}">Zu den Einstellungen</a></p>`,
    '<hr style="border: none; border-top: 1px solid #ccc; margin: 1.5rem 0;">',
    '<p>',
    leadEn,
    ` Its data is kept for 30 days, but locked. On <strong>${finalEn}</strong> it is deleted for good.`,
    '</p>',
    '<p>If you switch it on again before that day, everything is back as it was: the data, the settings and the open items.</p>',
    `<p><a href="${url}">Go to the settings</a></p>`,
    '</div>',
  ].join('\n')

  return { subject, html }
}
