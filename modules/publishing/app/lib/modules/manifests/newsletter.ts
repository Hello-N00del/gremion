import { Role } from '$lib/auth/types'
import type { ModuleManifest } from '../types'

import type { NavItem } from '$lib/components/layout/nav-schema'

// Newsletter (R33 F5, operator ruling Q3 2026-10-21): deselectable at RUNTIME per tenant AND at creation.
// OFF gates the newsletter PAGES and the /api/newsletter surface (lists, members, unsubscribe) and drops the
// Newsletter rail entry; the demo seed skips it (shouldSeedNewsletter). It does NOT gate kernel system mail:
// /api/internal/newsletter/* are the leaf's service callbacks (render / resolve-group / send-mail) and sit
// outside both prefixes, and SMTP / password-reset / notification mail do not route through this module.
// Task 23: served entirely by the extracted leaf service; the kernel routes proxy to it via the backend port.
export const newsletterManifest: ModuleManifest = {
  id: 'newsletter',
  order: 50,
  toggleable: true,
  pages: [{ segment: 'newsletter', minRole: Role.Finance }],
  routePrefixes: ['/newsletter', '/api/newsletter'],
  nav: [
    { kind: 'item', href: '/newsletter', label: 'Newsletter', icon: 'mail', role: Role.Finance, moduleId: 'newsletter' } satisfies NavItem,
  ],
}
