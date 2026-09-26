// packages/generated-clients/src/consumer-fixture/node-style.ts
//
// T8 (brief acceptance item 5): "a consumer fixture typechecks one
// node-style import". A plain Node/ESM consumer (e.g. TASK-084's Fastify
// governance service) resolves a relative deep import with an explicit
// `.js` specifier under `nodenext` resolution — the same resolution
// tsconfig.build.json uses for the whole package. This file is
// type-checked (not executed) by T8 in governance-contracts.test.ts, against
// tsconfig.consumer-node.json. Excluded from tsconfig.build.json (never in dist).
import { createGovernanceClient } from '../generated/governance-client.js'

export function nodeStyleConsumer() {
  const client = createGovernanceClient({ baseUrl: 'https://gov.example' })
  // Exercise one GET and one POST path so a real shape drift (a renamed
  // operation, a changed path template) fails typechecking here, not only
  // at the eventual real caller.
  return {
    getMeeting: () => client.GET('/api/v1/meetings/{meetingId}', { params: { path: { meetingId: 'x' } } }),
    createMotion: () =>
      client.POST('/api/v1/meetings/{meetingId}/motions', {
        params: { path: { meetingId: 'x' } },
        body: { title: 't', motion_text: 'm' },
      }),
  }
}
