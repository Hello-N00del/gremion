// packages/generated-clients/src/consumer-fixture/browser-style.ts
//
// T8 (brief acceptance item 5): "a consumer fixture typechecks ... one
// browser-style import". A bundler-resolved web app (e.g. TASK-032's
// gremion-ui) imports by the PACKAGE's public export subpath, never by a
// relative path into another package's src/. This file is type-checked
// (not executed) by consumer-fixture.test.ts against
// tsconfig.consumer-browser.json, which maps the subpath the same way
// package.json's own "exports"/"./governance-client" does — the actual
// resolution a real cross-package consumer gets once this package is
// linked into node_modules (verified structurally by package-shape.test.ts
// instead, which already asserts every dev "import" export has a matching
// published entry).
import { createGovernanceClient } from '@gremion/generated-clients/governance-client'

export function browserStyleConsumer() {
  const client = createGovernanceClient({ baseUrl: 'https://gov.example' })
  return {
    listAgendaItems: () => client.GET('/api/v1/meetings/{meetingId}/agenda-items', { params: { path: { meetingId: 'x' } } }),
    sendInvitation: () => client.POST('/api/v1/invitations/{invitationId}/send', { params: { path: { invitationId: 'x' } } }),
  }
}
