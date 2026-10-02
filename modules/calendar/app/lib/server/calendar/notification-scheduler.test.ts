import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../governance/governance-db', () => ({
  listDueNotifications: vi.fn().mockResolvedValue([]),
  markNotificationSent: vi.fn().mockResolvedValue(undefined),
  markNotificationFailed: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('node-cron', () => ({
  default: { schedule: vi.fn() }
}))

import { processDueNotifications } from './notification-scheduler'

describe('processDueNotifications', () => {
  beforeEach(() => {
    // Mock call history is shared across tests in this file (no global
    // clearMocks/resetMocks config); clear it per test so assertions on call
    // counts/order do not depend on execution order of earlier tests.
    vi.clearAllMocks()
  })

  it('does nothing when no notifications are due', async () => {
    const { listDueNotifications } = await import('../governance/governance-db')
    await processDueNotifications({ sendEmail: vi.fn() })
    expect(listDueNotifications).toHaveBeenCalledOnce()
  })

  it('marks notification sent after successful email', async () => {
    const { listDueNotifications, markNotificationSent } = await import('../governance/governance-db')
    vi.mocked(listDueNotifications).mockResolvedValueOnce([
      { id: 'n1', type: 'term_reminder', role_assignment_id: 'ra1',
        recipient_keycloak_id: 'u1', scheduled_for: new Date(),
        sent_at: null, failed_at: null, failure_reason: null }
    ] as any)

    await processDueNotifications({ sendEmail: vi.fn().mockResolvedValue(undefined) })

    expect(markNotificationSent).toHaveBeenCalledWith('n1')
  })

  it('marks notification failed when email throws', async () => {
    const { listDueNotifications, markNotificationFailed } = await import('../governance/governance-db')
    vi.mocked(listDueNotifications).mockResolvedValueOnce([
      { id: 'n2', type: 'grace_expiry', role_assignment_id: 'ra1',
        recipient_keycloak_id: 'u1', scheduled_for: new Date(),
        sent_at: null, failed_at: null, failure_reason: null }
    ] as any)

    await processDueNotifications({
      sendEmail: vi.fn().mockRejectedValue(new Error('SMTP error'))
    })

    expect(markNotificationFailed).toHaveBeenCalledWith('n2', 'SMTP error')
  })

  it('logs a send failure naming type, id and role_assignment_id, and still marks it failed', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { listDueNotifications, markNotificationFailed } = await import('../governance/governance-db')
    vi.mocked(listDueNotifications).mockResolvedValueOnce([
      { id: 'n3', type: 'grace_start', role_assignment_id: 'ra2',
        recipient_keycloak_id: 'u2', scheduled_for: new Date(),
        sent_at: null, failed_at: null, failure_reason: null }
    ] as any)

    await processDueNotifications({
      sendEmail: vi.fn().mockRejectedValue(new Error('SMTP down'))
    })

    expect(consoleErrorSpy).toHaveBeenCalledOnce()
    const [message] = consoleErrorSpy.mock.calls[0]
    expect(String(message)).toContain('grace_start')
    expect(String(message)).toContain('n3')
    expect(String(message)).toContain('ra2')
    expect(String(message)).toContain('SMTP down')
    expect(String(message)).not.toContain('u2')
    expect(markNotificationFailed).toHaveBeenCalledWith('n3', 'SMTP down')

    consoleErrorSpy.mockRestore()
  })

  it('keeps processing remaining notifications when markNotificationFailed rejects for an earlier one, and resolves', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { listDueNotifications, markNotificationFailed } = await import('../governance/governance-db')
    vi.mocked(listDueNotifications).mockResolvedValueOnce([
      { id: 'n4', type: 'term_reminder', role_assignment_id: 'ra3',
        recipient_keycloak_id: 'u3', scheduled_for: new Date(),
        sent_at: null, failed_at: null, failure_reason: null },
      { id: 'n5', type: 'term_reminder', role_assignment_id: 'ra4',
        recipient_keycloak_id: 'u4', scheduled_for: new Date(),
        sent_at: null, failed_at: null, failure_reason: null }
    ] as any)

    vi.mocked(markNotificationFailed)
      .mockRejectedValueOnce(new Error('DB write failed'))
      .mockResolvedValueOnce(undefined)

    const sendEmail = vi.fn()
      .mockRejectedValueOnce(new Error('SMTP error 1'))
      .mockRejectedValueOnce(new Error('SMTP error 2'))

    await expect(processDueNotifications({ sendEmail })).resolves.toBeUndefined()

    expect(sendEmail).toHaveBeenCalledTimes(2)
    expect(markNotificationFailed).toHaveBeenNthCalledWith(1, 'n4', 'SMTP error 1')
    expect(markNotificationFailed).toHaveBeenNthCalledWith(2, 'n5', 'SMTP error 2')

    // one console.error per send failure (n4, n5) plus one for the persist
    // failure when markNotificationFailed itself rejected for n4.
    expect(consoleErrorSpy).toHaveBeenCalledTimes(3)
    const messages = consoleErrorSpy.mock.calls.map(([msg]) => String(msg))
    expect(messages.some((m) => m.includes('n4') && m.includes('DB write failed'))).toBe(true)
    expect(messages.some((m) => m.includes('n5') && m.includes('SMTP error 2'))).toBe(true)
    expect(messages.every((m) => !m.includes('u3') && !m.includes('u4'))).toBe(true)

    // The persist-failure log line must name the notification the same way
    // the send-failure log line does (type + role_assignment_id), not just
    // its id — otherwise an operator scanning logs can't tell what expired.
    const persistFailureMessage = messages.find((m) => m.includes('n4') && m.includes('DB write failed'))
    expect(persistFailureMessage).toContain('term_reminder')
    expect(persistFailureMessage).toContain('ra3')

    consoleErrorSpy.mockRestore()
  })

  it('does not mark failed and logs distinct wording when markNotificationSent rejects after a successful send, then continues', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { listDueNotifications, markNotificationSent, markNotificationFailed } = await import(
      '../governance/governance-db'
    )
    vi.mocked(listDueNotifications).mockResolvedValueOnce([
      { id: 'n6', type: 'term_reminder', role_assignment_id: 'ra5',
        recipient_keycloak_id: 'u5', scheduled_for: new Date(),
        sent_at: null, failed_at: null, failure_reason: null },
      { id: 'n7', type: 'grace_start', role_assignment_id: 'ra6',
        recipient_keycloak_id: 'u6', scheduled_for: new Date(),
        sent_at: null, failed_at: null, failure_reason: null }
    ] as any)

    vi.mocked(markNotificationSent)
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(undefined)

    const sendEmail = vi.fn().mockResolvedValue(undefined)

    await expect(processDueNotifications({ sendEmail })).resolves.toBeUndefined()

    // Both emails were delivered — the second notification must still be
    // processed even though recording the first one's sent_at failed.
    expect(sendEmail).toHaveBeenCalledTimes(2)
    expect(markNotificationSent).toHaveBeenNthCalledWith(1, 'n6')
    expect(markNotificationSent).toHaveBeenNthCalledWith(2, 'n7')

    // The email WAS delivered, so this must never be marked permanently failed —
    // at-least-once delivery (retryable) is the safer failure mode here.
    expect(markNotificationFailed).not.toHaveBeenCalled()

    expect(consoleErrorSpy).toHaveBeenCalledOnce()
    const [message] = consoleErrorSpy.mock.calls[0]
    expect(String(message)).toContain('term_reminder')
    expect(String(message)).toContain('n6')
    expect(String(message)).toContain('ra5')
    expect(String(message)).toContain('connection reset')
    expect(String(message)).toContain('sent, but could not record sent_at')
    expect(String(message)).toContain('it may be sent again on the next tick')
    expect(String(message)).not.toContain('u5')
    expect(String(message)).not.toContain('u6')

    consoleErrorSpy.mockRestore()
  })
})
