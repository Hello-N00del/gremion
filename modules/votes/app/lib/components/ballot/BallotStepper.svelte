<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { env } from '$env/dynamic/public'
  import { createHeliosVoterSession } from '$lib/client/helios-voter-session.svelte'
  import { loadJsCrypto, encryptAnswer } from '$lib/client/ballot-engine'
  import { castBallot } from '$lib/client/cast-service'
  import { Button } from '$lib/components/ui/button'
  import SessionGate from './SessionGate.svelte'
  import BallotQuestion from './BallotQuestion.svelte'
  import BallotReview from './BallotReview.svelte'
  import BallotConfirmation from './BallotConfirmation.svelte'

  interface HeliosQuestion { question: string; answers: string[]; min: number; max: number; answer_type: string }
  interface Props { electionUuid: string; questions: HeliosQuestion[]; publicKey: unknown; heliosBase: string }
  let { electionUuid, questions, publicKey, heliosBase }: Props = $props()

  const gremionUiOrigin = env.PUBLIC_BASE_URL ?? 'http://localhost:3001'
  const callbackPath = `/elections/${electionUuid}/helios-cb`

  const session = createHeliosVoterSession({ heliosBase, callbackPath, electionUuid, gremionUiOrigin })

  let cryptoReady = $state(false)
  let cryptoError = $state('')

  onMount(async () => {
    try {
      await loadJsCrypto(heliosBase)
      cryptoReady = true
    } catch (err) {
      // Without this the rejection is uncaught, cryptoReady stays false forever and
      // the submit button is silently disabled with no explanation.
      cryptoError = err instanceof Error ? err.message : 'Unbekannter Fehler'
    }
  })
  onDestroy(() => { session.destroy() })

  let step = $state(0)
  let selections = $state<number[][]>(questions.map(() => []))
  let submitting = $state(false)
  let auditUrl = $state('')
  let castError = $state('')

  const REVIEW_STEP = questions.length
  const DONE_STEP = questions.length + 1

  function canAdvance(qi: number): boolean {
    const q = questions[qi]
    if (!q) return false
    if (q.answer_type === 'stv') return true
    return selections[qi].length >= q.min && selections[qi].length <= q.max
  }

  function reviewQuestions() {
    return questions.map((q, i) => ({
      questionText: q.question,
      selectedAnswers: selections[i].map((idx) => q.answers[idx]),
    }))
  }

  async function submit(): Promise<void> {
    submitting = true; castError = ''
    try {
      const encryptedAnswers = questions.map((q, i) =>
        q.answer_type === 'stv' ? null : encryptAnswer(q, selections[i], publicKey)
      )
      const encryptedVote = JSON.stringify(encryptedAnswers)
      const msgBuffer = new TextEncoder().encode(encryptedVote)
      const hashBuffer = await crypto.subtle.digest('SHA-1', msgBuffer)
      const auditHash = Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('')
      const result = await castBallot({ heliosBase, electionUuid, encryptedVote, auditHash })
      auditUrl = result.auditUrl
      step = DONE_STEP
    } catch (err) {
      castError = err instanceof Error ? err.message : 'Unbekannter Fehler'
    } finally { submitting = false }
  }

  const oidcLoginUrl = `${heliosBase}/auth/start/keycloak_oidc?return_url=${encodeURIComponent(`${gremionUiOrigin}${callbackPath}`)}`
</script>

<SessionGate state={session.state} {oidcLoginUrl}>
  {#if cryptoError}
    <div role="alert" class="mb-4 rounded-lg border border-border bg-surface-2/30 p-4 space-y-2">
      <p class="text-sm text-rust">Die Verschlüsselung konnte nicht geladen werden — in dieser Ansicht kann derzeit keine Stimme abgegeben werden.</p>
      <p class="text-xs text-ink-muted">{cryptoError}</p>
      <a href="{heliosBase}/booth/vote.html?election_url=/helios/elections/{electionUuid}" target="_blank" rel="noopener noreferrer" class="text-sm text-accent hover:underline">Direkt in Helios abstimmen ↗</a>
    </div>
  {/if}
  {#if step < REVIEW_STEP}
    {@const q = questions[step]}
    {#if q.answer_type === 'stv'}
      <div class="rounded-lg border border-border bg-surface-2/30 p-6 space-y-3">
        <p class="text-sm text-ink-muted">Diese Wahlmethode (STV) wird in der nativen Ansicht noch nicht unterstützt.</p>
        <a href="{heliosBase}/booth/vote.html?election_url=/helios/elections/{electionUuid}" target="_blank" rel="noopener noreferrer" class="text-sm text-accent hover:underline">Direkt in Helios abstimmen ↗</a>
      </div>
    {:else}
      <div class="space-y-6">
        <BallotQuestion
          questionText={q.question} questionIndex={step} questionTotal={questions.length}
          answers={q.answers.map((text, index) => ({ index, text }))}
          selectedIndices={selections[step]} min={q.min} max={q.max}
          onselect={(indices) => { selections[step] = indices }}
        />
        <div class="flex justify-between">
          {#if step > 0}
            <Button variant="outline" onclick={() => { step -= 1 }}>← Zurück</Button>
          {:else}
            <div></div>
          {/if}
          <Button onclick={() => { step += 1 }} disabled={!canAdvance(step)}>
            {step < REVIEW_STEP - 1 ? 'Weiter →' : 'Überprüfen →'}
          </Button>
        </div>
      </div>
    {/if}
  {:else if step === REVIEW_STEP}
    <BallotReview questions={reviewQuestions()} onback={(qi) => { step = qi }} onsubmit={submit} {submitting} disabled={!cryptoReady} />
    {#if castError}<p class="mt-3 text-sm text-rust">{castError}</p>{/if}
  {:else}
    <BallotConfirmation {auditUrl} />
  {/if}
</SessionGate>
