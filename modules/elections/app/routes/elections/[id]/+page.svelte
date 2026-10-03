<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData } from './$types'
  import { Alert } from '$lib/components/ui/alert'
  import Pill from '$lib/components/pills/Pill.svelte'
  import { Button } from '$lib/components/ui/button'
  import { env } from '$env/dynamic/public'
  import BallotStepper from '$lib/components/ballot/BallotStepper.svelte'

  let { data }: { data: PageData } = $props()
  const heliosBase = env.PUBLIC_HELIOS_URL ?? ''

  function formatDateTime(iso: string | null): string {
    if (!iso) return '–'
    return new Date(iso).toLocaleString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  function lifecycleLabel(lc: 'draft' | 'open' | 'closed'): string {
    return lc === 'draft' ? 'Entwurf' : lc === 'open' ? 'Laufend' : 'Geschlossen'
  }

  // Lifecycle → Pill tone/glyph: an OPEN election is the active-instance state
  // (accent, per #287) and needs an explicit glyph to satisfy the pill-icon
  // contract's spirit; closed/draft are neutral with explicit glyphs.
  function lifecycleTone(lc: 'draft' | 'open' | 'closed'): 'accent' | 'neutral' {
    return lc === 'open' ? 'accent' : 'neutral'
  }
  function lifecycleIcon(lc: 'draft' | 'open' | 'closed'): string {
    return lc === 'open' ? 'ballot' : lc === 'closed' ? 'lock' : 'edit'
  }

  const e = $derived(data.election)
  const totalVoters = $derived(data.voters.length)
  const castVoters = $derived(data.voters.filter((v) => v.cast_at !== null).length)
  const turnout = $derived(
    totalVoters === 0 ? 0 : Math.round((castVoters / totalVoters) * 100),
  )
</script>

<PageTitle title={e.name} />

<div class="mx-auto max-w-4xl space-y-6 p-6">
  <div class="flex items-center gap-3">
    <a href="/elections" class="text-sm text-ink-muted hover:underline">← Wahlen</a>
  </div>

  <!-- Header card -->
  <div class="rounded-lg border bg-surface">
    <div class="px-6 pt-6 pb-0">
      <div class="flex items-start justify-between gap-2">
        <div>
          <h1 class="text-xl font-semibold">{e.name}</h1>
          <p class="text-sm text-ink-muted">Kurzname: <code>{e.shortName}</code></p>
        </div>
        <div class="flex gap-1 shrink-0">
          <Pill tone={lifecycleTone(e.lifecycle)} icon={lifecycleIcon(e.lifecycle)}>{lifecycleLabel(e.lifecycle)}</Pill>
          {#if e.calendarLinked}
            <Pill>Kalender</Pill>
          {/if}
        </div>
      </div>
      {#if e.description}
        <p class="text-sm text-ink-muted mt-2">{e.description}</p>
      {/if}
    </div>
    <div class="p-6 space-y-2 text-sm">
      <div class="grid grid-cols-2 gap-2">
        <div><span class="text-ink-muted">Start:</span> {formatDateTime(e.votingStartsAt)}</div>
        <div><span class="text-ink-muted">Ende:</span> {formatDateTime(e.votingEndsAt)}</div>
        <div><span class="text-ink-muted">Eingefroren:</span> {formatDateTime(e.frozenAt)}</div>
        <div><span class="text-ink-muted">Abgegebene Stimmen:</span> {e.numCastVotes}</div>
      </div>
      {#if e.lifecycle === 'draft' && data.isAdmin}
        <div class="pt-3">
          <Button href="/elections/{e.uuid}/manage" variant="outline">Verwalten →</Button>
        </div>
      {/if}
    </div>
  </div>

  <!-- Native ballot (open elections) -->
  {#if e.lifecycle === 'open'}
    <section aria-labelledby="ballot-heading" class="rounded-lg border bg-surface p-6">
      <h2 id="ballot-heading" class="text-lg font-semibold mb-6">Abstimmung</h2>
      {#if data.questions?.length && data.publicKey}
        <BallotStepper
          electionUuid={e.uuid}
          questions={data.questions}
          publicKey={data.publicKey}
          {heliosBase}
        />
      {:else}
        <p class="text-sm text-ink-muted mb-4">Direkter Zugriff auf Helios erforderlich.</p>
        <a href="{heliosBase}/booth/vote.html?election_url=/helios/elections/{e.uuid}" target="_blank" rel="noopener noreferrer" class="text-sm text-accent hover:underline">In Helios abstimmen ↗</a>
      {/if}
    </section>
  {/if}

  <!-- Voter ledger (admin only) -->
  {#if data.isAdmin}
    <section aria-labelledby="voters-heading" class="rounded-lg border bg-surface">
      <div class="px-6 pt-6 pb-0 flex items-center justify-between">
        <h2 id="voters-heading" class="text-lg font-semibold">Wählerverzeichnis</h2>
        {#if totalVoters > 0}
          <span class="text-sm text-ink-muted">
            Wahlbeteiligung: {castVoters}/{totalVoters} ({turnout}%)
          </span>
        {/if}
      </div>
      <div class="p-6">
        {#if data.voters.length === 0}
          <Alert>
            Kein Wählerverzeichnis verfügbar. (Entweder nicht hochgeladen oder Helios nicht
            erreichbar.)
          </Alert>
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="border-b text-left">
                <tr>
                  <th class="py-2 pr-4 font-medium">Name</th>
                  <th class="py-2 pr-4 font-medium">Login-ID</th>
                  <th class="py-2 pr-4 font-medium">Status</th>
                  <th class="py-2 font-medium">Abgegeben am</th>
                </tr>
              </thead>
              <tbody>
                {#each data.voters as v (v.uuid)}
                  <tr class="border-b last:border-0">
                    <td class="py-2 pr-4">{v.name}</td>
                    <td class="py-2 pr-4 font-mono text-xs">{v.voter_login_id ?? '–'}</td>
                    <td class="py-2 pr-4">
                      {#if v.cast_at}
                        <Pill tone="success">Abgestimmt</Pill>
                      {:else}
                        <Pill tone="warn">Offen</Pill>
                      {/if}
                    </td>
                    <td class="py-2">{formatDateTime(v.cast_at)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    </section>
  {/if}

  <!-- Tally (post-close) -->
  {#if e.lifecycle === 'closed'}
    <section aria-labelledby="result-heading" class="rounded-lg border bg-surface">
      <div class="px-6 pt-6 pb-0">
        <h2 id="result-heading" class="text-lg font-semibold">Ergebnis</h2>
      </div>
      <div class="p-6 space-y-6">
        {#if data.result === null}
          <Alert>
            Ergebnis noch nicht berechnet. Die Auszählung muss im Helios-Admin ausgelöst werden.
          </Alert>
        {:else}
          {#each data.result.questions as q, qIdx (qIdx)}
            {@const maxCount = Math.max(1, ...q.tally)}
            <div>
              <h3 class="font-semibold mb-1">{q.question}</h3>
              <p class="text-xs text-ink-muted mb-3">{q.num_tallied} Stimmen gezählt</p>
              <ul class="space-y-2" role="list">
                {#each q.answers as answer, i (i)}
                  {@const count = q.tally[i] ?? 0}
                  {@const pct = Math.round((count / maxCount) * 100)}
                  <li>
                    <div class="flex items-center justify-between text-sm mb-1">
                      <span>{answer}</span>
                      <span class="text-ink-muted">{count}</span>
                    </div>
                    <div class="h-2 rounded-full bg-surface-2 overflow-hidden">
                      <div
                        class="h-full bg-accent transition-[width]"
                        style="width: {pct}%"
                      ></div>
                    </div>
                  </li>
                {/each}
              </ul>
            </div>
          {/each}
        {/if}
      </div>
    </section>
  {/if}
</div>
