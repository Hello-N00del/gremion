// Shared dashboard card-section formatting helpers (gremion#22 — G5 kernel
// dashboard split). Moved out of +page.svelte verbatim; the only
// edit is that the three functions that read `$t` (a reactive store
// auto-subscription, only valid inside a .svelte component) now take the
// resolved translate function as a parameter instead — callers pass `$t`
// from their own component. No formatting logic changed.
import type { MyApproval } from './types'

export const eur0 = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
})

// Compact "Wo Tag.Monat" agenda date for an event start (e.g. "Mo 06.05").
export function fmtEventWhen(iso: string): string {
  const d = new Date(iso)
  const wd = d.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '')
  const dm = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
  return `${wd} ${dm}`
}

// "Heute 18:00" / "Di 06.05 · 18:00" pill for the featured next meeting.
export function fmtMeetingPill(iso: string, translate: (key: string) => string): string {
  const d = new Date(iso)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  return sameDay ? `${translate('dashboard.countdown.today')} ${time}` : `${fmtEventWhen(iso)} · ${time}`
}

// Coarse human countdown to the next meeting ("in 7 Std 42 Min" / "in 3 Tagen").
export function fmtCountdown(iso: string, translate: (key: string) => string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return translate('dashboard.countdown.running')
  const min = Math.round(ms / 60000)
  if (min < 60) return `${min} ${translate('dashboard.unit.min')}`
  const hrs = Math.floor(min / 60)
  if (hrs < 24) return `${hrs} ${translate('dashboard.unit.hrs')} ${min % 60} ${translate('dashboard.unit.min')}`
  const days = Math.round(hrs / 24)
  return days === 1 ? `1 ${translate('dashboard.unit.day')}` : `${days} ${translate('dashboard.unit.days')}`
}

export function greeting(translate: (key: string) => string): string {
  const h = new Date().getHours()
  if (h < 12) return translate('dashboard.morning')
  if (h < 18) return translate('dashboard.afternoon')
  return translate('dashboard.evening')
}

export const TYPE_LABEL: Record<MyApproval['type'], string> = {
  expense: 'Ausgabe',
  project: 'Projekt',
  budget: 'Haushalt',
}

export function approvalAmount(cents: number | null): string | null {
  return cents == null ? null : eur0.format(cents / 100)
}

export function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 1) return 'gerade eben'
  if (min < 60) return `vor ${min} Min`
  const hrs = Math.round(min / 60)
  if (hrs < 24) return `vor ${hrs} Std`
  const days = Math.round(hrs / 24)
  return days === 1 ? 'gestern' : `vor ${days} Tagen`
}
