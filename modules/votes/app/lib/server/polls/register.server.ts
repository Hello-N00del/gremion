// src/lib/server/polls/register.server.ts
// TRD-196: the votes module self-registers its erasure hook into the
// runtime-registry seam, so the kernel erasure orchestrator never imports votes
// internals. Loaded for its side effects by the generated server-init barrel.
//
// Module Karenz (phase 2, Task 13): the same seam carries the votes participant (freeze and restore
// the Polls deadlines), its sealed poll results and the deletion preview of the switch-off warning.
import { registerErasureHook } from '$lib/server/modules/runtime-registry'
import { registerKarenzParticipant } from '$lib/server/module-karenz/participants'
import { registerRetentionExtractor } from '$lib/server/module-karenz/retained/extractors'
import { registerDeletionPreviewProvider } from '$lib/server/module-switch/preview'
import { votesErasureHook } from './erasure'
import { votesDeletionPreview, votesKarenz } from './karenz'
import { pollResultsExtractor } from './retained'

registerErasureHook(votesErasureHook)
registerKarenzParticipant(votesKarenz)
registerRetentionExtractor(pollResultsExtractor)
registerDeletionPreviewProvider('votes', votesDeletionPreview)
