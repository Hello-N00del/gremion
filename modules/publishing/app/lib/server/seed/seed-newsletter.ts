// src/lib/server/seed/seed-newsletter.ts
// P0 demo newsletter fixtures (behind SEED_DEMO_FIXTURES). This consumer routes
// through the backend port (getNewsletterBackend), so it is transport-agnostic.
// Task 23: the only backend is the HTTP ACL to the newsletter leaf service, so
// these writes create the demo issues IN THE LEAF. The FIRST backend write is
// wrapped in try/catch so a seed run while the leaf is unreachable (or a future
// CLI seeder outside a booted server) logs + skips rather than throwing;
// behaviour (skip-on-unavailable, the 3 demo issues, status updates) is unchanged.
import { getNewsletterBackend, type NewsletterBackendPort } from '../newsletter/backend'

export interface NewsletterSeedResult {
  /** Number of newsletter rows created (0 when skipped). */
  count: number
  /** True when the newsletter backend was unavailable and seeding was skipped. */
  skipped: boolean
}

export async function seedNewsletter(
  userIds: ReadonlyMap<string, string>
): Promise<NewsletterSeedResult> {
  const createdBy = userIds.get('emma.fischer')
  if (createdBy === undefined) throw new Error('seedNewsletter: unknown user "emma.fischer"')

  const issues: Array<{
    title: string
    update: Parameters<NewsletterBackendPort['updateNewsletter']>[1]
  }> = [
    {
      title: 'Update April 2026',
      update: { status: 'sent', sent_at: '2026-04-01T10:00:00' },
    },
    {
      title: 'Mai-Ausgabe · Sommerfest & Erstis',
      update: { status: 'scheduled', scheduled_at: '2026-05-02T10:00:00' },
    },
    {
      // Default status 'draft' — no update needed.
      title: 'Juni-Vorschau (Entwurf)',
      update: {},
    },
  ]

  const backend = getNewsletterBackend()

  let count = 0
  try {
    for (const issue of issues) {
      const nl = await backend.createNewsletter({
        title: issue.title,
        odt_path: '/data/newsletters/placeholder.odt',
        subject: issue.title,
        created_by: createdBy,
      })
      if (Object.keys(issue.update).length > 0) {
        await backend.updateNewsletter(nl.id, issue.update)
      }
      count++
    }
  } catch (err) {
    // Backend unavailable (e.g. the newsletter leaf service is unreachable, or
    // seeding runs outside a booted server). The service client throws on the
    // first HTTP write rather than at construction. Skip gracefully — the
    // newsletter fixtures are non-critical demo data (a reachable leaf seeds all
    // 3, an unreachable one skips with count 0).
    if (count === 0) {
      console.warn(
        `seedNewsletter: newsletter backend unavailable, skipping demo newsletters (${
          err instanceof Error ? err.message : String(err)
        })`
      )
      return { count: 0, skipped: true }
    }
    throw err
  }
  return { count, skipped: false }
}
