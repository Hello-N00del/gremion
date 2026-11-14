<script lang="ts">
  import { Input } from '$lib/components/ui/input'
  import { Button } from '$lib/components/ui/button'
  import { computeResult, type MajorityRule } from '$lib/governance/compute-result'
  import { isUntalliedResolution } from '$lib/governance/resolution-vote-state'

  interface Resolution {
    id?: string
    sequence_nr: number
    global_nr?: string | null
    text: string
    votes_yes: number
    votes_no: number
    votes_abstain: number
    result: 'passed' | 'rejected' | 'withdrawn'
    // The editor creates the three majority rules; consent/support_threshold and
    // acclamation rows come from the API until the Phase-2 row UI lands
    // (TASK-206-A: that port needs the not-taken input.svelte change, TASK-165).
    required_majority: 'simple' | 'two_thirds' | 'absolute'
    // Phase-2 row shape as the API returns it (R28 review). Optional so the
    // protocol page's row type stays assignable both ways; an acclamation row
    // carries NULL tallies at runtime, a support_threshold row its fraction.
    adoption_mode?: 'tally' | 'acclamation'
    decision_rule_params?: { fraction?: number } | null
  }

  let { resolution, isAdmin, protocolId, eligibleVotingCount = 0, startEditing = false, error = null, onSave, onDelete, onCancel }: {
    resolution: Resolution
    isAdmin: boolean
    protocolId: string
    // The eligible voting count for the `absolute` rule's display mirror; the
    // server is still the authority. Defaults to 0 so the row renders even before
    // the roster is known (only the `absolute` preview depends on it).
    eligibleVotingCount?: number
    // An unsaved draft (no id) opens as the entry form; Abbrechen then discards it
    // through `onCancel` instead of just closing the editor.
    startEditing?: boolean
    // A refusal from the server for the last save, shown inside the form.
    error?: string | null
    // May resolve to `false` when the save was refused: the form then stays open
    // so the typed text is not lost.
    onSave: (r: Resolution) => void | boolean | Promise<void | boolean>
    onDelete: (id: string) => void
    onCancel?: () => void
  } = $props()

  const uid = $props.id()
  let editing = $state(startEditing)
  let draft = $state({ ...resolution })
  // A decision is stored only with its text (the server refuses it too).
  let textMissing = $state(false)

  // A new decision is stored with all three counts; a cleared field is not a 0.
  let countsMissing = $state(false)
  // True while onSave is pending: the save cannot be repeated or cancelled.
  let saving = $state(false)

  const countIsBlank = (v: unknown) => v === null || v === undefined || v === ''

  async function save() {
    if (saving) return
    if (typeof draft.text !== 'string' || draft.text.trim() === '') {
      textMissing = true
      return
    }
    textMissing = false
    // An unsaved draft is a tally row whose counts are stored as typed, so a
    // blank one would become a counted 0. Existing rows keep the server's rule.
    countsMissing =
      !resolution.id &&
      draft.adoption_mode !== 'acclamation' &&
      (countIsBlank(draft.votes_yes) || countIsBlank(draft.votes_no) || countIsBlank(draft.votes_abstain))
    if (countsMissing) return
    saving = true
    try {
      const ok = await onSave(draft)
      if (ok !== false) editing = false
    } finally {
      saving = false
    }
  }

  function cancel() {
    if (saving) return
    textMissing = false
    countsMissing = false
    editing = false
    onCancel?.()
  }

  const RESULT_LABEL: Record<string, string> = {
    passed: '✓ Angenommen',
    rejected: '✗ Abgelehnt',
    withdrawn: '— Zurückgezogen',
  }
  const RESULT_CLASS: Record<string, string> = {
    passed: 'text-green-700',
    rejected: 'text-red-700',
    withdrawn: 'text-ink-muted',
  }
  const RULE_LABEL: Record<MajorityRule, string> = {
    simple: 'Einfache Mehrheit',
    two_thirds: 'Zwei-Drittel-Mehrheit',
    absolute: 'Absolute Mehrheit',
    consent: 'Konsens',
    support_threshold: 'Unterstützungsquorum',
  }

  // Rule labels are keyed by the full five-rule vocabulary; the row type keeps
  // the editor's three, but API rows carry consent/support_threshold too.
  const ruleOf = (r: Resolution): MajorityRule => r.required_majority as MajorityRule
  const isAcclamation = $derived(resolution.adoption_mode === 'acclamation')

  // A counted row whose counts are all zero (or empty) has not been voted on yet:
  // a fresh row is created as 0/0/0 and the server computes "rejected" for it,
  // which must not be shown as a decision (finding 7). The predicate is the one
  // the server's submit and publish gates use (resolution-vote-state.ts), so the
  // row and the server agree: withdrawn rows keep their verdict, acclamation rows
  // carry a declared result and no tally by design, and a consent row with an
  // empty tally is ADOPTED (silence adopts), not a missing vote.
  const hasNoVote = $derived(isUntalliedResolution(resolution))
  // In the editor a cleared field (null or '') is a missing count, which the
  // "Stimmen unvollständig" line below explains; only explicit zeros mean "not
  // voted yet".
  const isBlank = (v: unknown) => v === null || v === undefined || v === ''
  const draftHasNoVote = $derived(
    !isBlank(draft.votes_yes) &&
      !isBlank(draft.votes_no) &&
      !isBlank(draft.votes_abstain) &&
      isUntalliedResolution(draft),
  )

  // INV-5: the result shown while editing is COMPUTED from the fixed rule +
  // tallies — never an admin's free hand. A withdrawn resolution keeps its
  // withdrawn verdict; an acclamation row shows the chair's declared result
  // (nothing is computed); otherwise mirror the server's evaluator, including
  // the support_threshold fraction stored on the row.
  const previewResult = $derived(
    draft.result === 'withdrawn'
      ? 'withdrawn'
      : isAcclamation
        ? draft.result
        : computeResult(
            draft.votes_yes,
            draft.votes_no,
            ruleOf(draft),
            eligibleVotingCount,
            draft.decision_rule_params?.fraction,
          ),
  )
  // Why no verdict can be shown: a support_threshold row without a declared
  // fraction lacks its rule parameter; otherwise a tally is missing.
  const missingCause = $derived(
    ruleOf(draft) === 'support_threshold' && typeof draft.decision_rule_params?.fraction !== 'number'
      ? 'Regel unvollständig'
      : 'Stimmen unvollständig',
  )
</script>

{#if editing && isAdmin}
  <div class="rounded-md border p-3 space-y-2">
    <Input bind:value={draft.text} placeholder="Beschlusstext" aria-label="Beschlusstext" aria-invalid={textMissing || undefined} />
    {#if textMissing || countsMissing || error}
      <p role="alert" class="text-sm text-red-700">{textMissing
        ? 'Bitte den Beschlusstext eingeben.'
        : countsMissing
          ? 'Bitte alle drei Stimmzahlen angeben (0, wenn niemand so gestimmt hat).'
          : error}</p>
    {/if}
    <div class="flex flex-wrap items-center gap-2">
      <!-- Visible labels (finding 7): the tally fields were announced only by
           their placeholders, which vanish once a number is typed. -->
      <div class="flex flex-col gap-0.5">
        <label for="{uid}-yes" class="text-xs text-ink-muted">Ja</label>
        <Input id="{uid}-yes" type="number" min="0" bind:value={draft.votes_yes} class="w-16" />
      </div>
      <div class="flex flex-col gap-0.5">
        <label for="{uid}-no" class="text-xs text-ink-muted">Nein</label>
        <Input id="{uid}-no" type="number" min="0" bind:value={draft.votes_no} class="w-16" />
      </div>
      <div class="flex flex-col gap-0.5">
        <label for="{uid}-abstain" class="text-xs text-ink-muted">Enthaltung</label>
        <Input id="{uid}-abstain" type="number" min="0" bind:value={draft.votes_abstain} class="w-24" />
      </div>
      {#if resolution.id}
        <!-- INV-5: the decision rule is FIXED at creation; an existing resolution
             shows it locked, never as an editable selector. -->
        <span class="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-ink-muted">
          🔒 {RULE_LABEL[ruleOf(draft)]} · Bei Erstellung festgelegt
        </span>
      {:else}
        <select bind:value={draft.required_majority} class="rounded-md border px-2 py-1 text-sm" aria-label="Erforderliche Mehrheit">
          <option value="simple">Einfache Mehrheit</option>
          <option value="two_thirds">Zwei-Drittel-Mehrheit</option>
          <option value="absolute">Absolute Mehrheit</option>
        </select>
      {/if}
    </div>
    <!-- INV-5: result is computed, not chosen. Shown read-only, tagged 'berechnet'. -->
    {#if draftHasNoVote}
      <!-- Nothing counted yet: a computed "Abgelehnt" for 0/0/0 would read as a
           decision that was never taken (finding 7). -->
      <div class="text-sm text-ink-muted">Ergebnis: noch keine Abstimmung</div>
    {:else if previewResult && isAcclamation && previewResult !== 'withdrawn'}
      <div class="text-sm {RESULT_CLASS[previewResult]}">
        Ergebnis: {RESULT_LABEL[previewResult]} <span class="text-xs text-ink-muted">(per Akklamation festgestellt)</span>
      </div>
    {:else if previewResult}
      <div class="text-sm {RESULT_CLASS[previewResult]}">
        Ergebnis: {RESULT_LABEL[previewResult]} <span class="text-xs text-ink-muted">(berechnet)</span>
      </div>
    {:else}
      <!-- computeResult is null when a tally or the rule's parameter is missing:
           no verdict is shown rather than a guessed one, and the cause is named;
           the server computes the authoritative result. -->
      <div class="text-sm text-ink-muted">Ergebnis: nicht berechenbar ({missingCause})</div>
    {/if}
    <div class="flex gap-2">
      <Button size="sm" onclick={save} disabled={saving}>Speichern</Button>
      <Button size="sm" variant="ghost" onclick={cancel} disabled={saving}>Abbrechen</Button>
      {#if resolution.id && draft.result !== 'withdrawn'}
        <Button
          size="sm"
          variant="ghost"
          class="text-red-700"
          onclick={() => { draft.result = 'withdrawn'; onSave(draft); editing = false }}
        >Zurückziehen</Button>
      {/if}
    </div>
  </div>
{:else}
  <div class="flex items-start justify-between rounded-md border px-3 py-2">
    <div>
      {#if resolution.global_nr}
        <span class="text-xs font-mono text-ink-muted mr-2">{resolution.global_nr}</span>
      {/if}
      <span>{resolution.text}</span>
      {#if hasNoVote}
        <div class="text-sm text-ink-muted">noch keine Abstimmung</div>
      {:else}
      <div class="text-sm {RESULT_CLASS[resolution.result]}">
        {RESULT_LABEL[resolution.result]}
        {#if isAcclamation}
          <!-- Acclamation: the chair declared the outcome; there is no tally to
               show and the stored rule is inert (mirror of /beschluesse). -->
          <span class="text-xs text-ink-muted">· per Akklamation</span>
        {:else}
          · {resolution.votes_yes} Ja / {resolution.votes_no} Nein / {resolution.votes_abstain} Enthal.
          <span class="text-xs text-ink-muted">· {RULE_LABEL[ruleOf(resolution)]}</span>
        {/if}
      </div>
      {/if}
    </div>
    {#if isAdmin}
      <div class="flex gap-1 ml-2 shrink-0">
        <Button size="sm" variant="ghost" onclick={() => editing = true}>Bearbeiten</Button>
        <Button size="sm" variant="ghost" onclick={() => resolution.id && onDelete(resolution.id)}>✕</Button>
      </div>
    {/if}
  </div>
{/if}
