// packages/generated-clients/src/consumer-fixture/browser-style.ts
//
// T8 (brief acceptance item 5): "a consumer fixture typechecks ... one
// browser-style import". A bundler-resolved web app (e.g. TASK-032's
// gremion-ui) imports by the PACKAGE's public export subpath, never by a
// relative path into another package's src/. This file is type-checked
// (not executed) by T8 in governance-contracts.test.ts against
// tsconfig.consumer-browser.json, which has no `paths` shim: the specifier
// resolves by package self-reference through package.json
// "exports"."./governance-client" under bundler resolution, the same export
// map a linked consumer reads. Dropping that export fails this file with
// TS2307. Excluded from tsconfig.build.json, so it never ships in dist.
import { createGovernanceClient } from '@gremion/generated-clients/governance-client'

export function browserStyleConsumer() {
  const client = createGovernanceClient({ baseUrl: 'https://gov.example' })
  return {
    listAgendaItems: () => client.GET('/api/v1/meetings/{meetingId}/agenda-items', { params: { path: { meetingId: 'x' } } }),
    sendInvitation: () => client.POST('/api/v1/invitations/{invitationId}/send', { params: { path: { invitationId: 'x' } } }),
  }
}
