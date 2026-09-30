<script lang="ts">
  import { Input } from '$lib/components/ui/input'
  import { Button } from '$lib/components/ui/button'
  import { computeResult, type MajorityRule } from '$lib/governance/compute-result'

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

  let { resolution, isAdmin, protocolId, eligibleVotingCount = 0, onSave, onDelete }: {
    resolution: Resolution
    isAdmin: boolean
    protocolId: string
    // The eligible voting count for the `absolute` rule's display mirror; the
    // server is still the authority. Defaults to 0 so the row renders even before
    // the roster is known (only the `absolute` preview depends on it).
    eligibleVotingCount?: number
    onSave: (r: Resolution) => void
    onDelete: (id: string) => void
  } = $props()

  let editing = $state(false)
  let draft = $state({ ...resolution })

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
    <Input bind:value={draft.text} placeholder="Beschlusstext" />
    <div class="flex flex-wrap items-center gap-2">
      <Input type="number" bind:value={draft.votes_yes} placeholder="Ja" class="w-16" />
      <Input type="number" bind:value={draft.votes_no} placeholder="Nein" class="w-16" />
      <Input type="number" bind:value={draft.votes_abstain} placeholder="Enthal." class="w-20" />
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
    {#if previewResult && isAcclamation && previewResult !== 'withdrawn'}
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
      <Button size="sm" onclick={() => { onSave(draft); editing = false }}>Speichern</Button>
      <Button size="sm" variant="ghost" onclick={() => editing = false}>Abbrechen</Button>
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
    </div>
    {#if isAdmin}
      <div class="flex gap-1 ml-2 shrink-0">
        <Button size="sm" variant="ghost" onclick={() => editing = true}>Bearbeiten</Button>
        <Button size="sm" variant="ghost" onclick={() => resolution.id && onDelete(resolution.id)}>✕</Button>
      </div>
    {/if}
  </div>
{/if}
