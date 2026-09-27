/**
 * Fixture module manifest with nav items (TASK-208). The kernel manifests
 * (core.ts, governance.ts) declare no `nav`, so the icon-map and current-page
 * tests weave this one in until TASK-205's module manifests join the registry.
 * It is never registered: it lives beside the tests, not under modules/manifests.
 */
import type { ModuleManifest } from '$lib/modules/types'
import { Role } from '$lib/auth/types'

export const NAV_FIXTURE_MANIFEST: ModuleManifest = {
  id: 'fixture_messages',
  toggleable: true,
  pages: [{ segment: 'messages', minRole: Role.Member }],
  routePrefixes: ['/messages'],
  nav: [
    {
      kind: 'section',
      label: 'Kommunikation',
      moduleId: 'fixture_messages',
      children: [
        { kind: 'item', href: '/messages', label: 'Nachrichten', icon: 'mail', badge: 'unread', role: Role.Member, moduleId: 'fixture_messages' },
        { kind: 'item', href: '/messages/manage', label: 'Nachrichten verwalten', icon: 'sliders', role: Role.CouncilAdmin, moduleId: 'fixture_messages' }
      ]
    }
  ]
}
