<script lang="ts">
  import { base } from '$app/paths';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // Beschluss-Nr: prefer the published global_nr (B-YYYY-NNN); fall back to a
  // number synthesized from the meeting year + per-protocol sequence — same
  // rule as the internal Beschlussbuch.
  function beschlussNr(b: PageData['beschluesse'][number]): string {
    if (b.global_nr) return b.global_nr;
    const year = new Date(b.meeting_date).getFullYear();
    return `B-${year}-${String(b.sequence_nr).padStart(3, '0')}`;
  }

  function unanimous(b: PageData['beschluesse'][number]): boolean {
    // Acclamation rows carry NO tally (null, not 0) — a null tally can never
    // read as 'einstimmig'; those rows render the 'per Akklamation' pill instead.
    if (b.votes_yes === null || b.votes_no === null || b.votes_abstain === null) return false;
    return b.votes_no === 0 && b.votes_abstain === 0 && b.votes_yes > 0;
  }
</script>

<svelte:head>
  <title>Beschlüsse — Studierendenrat</title>
  <meta name="description" content="Öffentliches Beschlussregister der Ausschüsse des Studierendenrats." />
</svelte:head>

<!-- Page header -->
<div class="border-b border-ink-subtle bg-surface">
  <div class="mx-auto max-w-7xl px-5 py-10">
    <p class="mb-2 font-mono text-[10px] tracking-widest text-ink-muted uppercase">Transparenz</p>
    <h1 class="font-display text-4xl font-bold text-ink">Beschlüsse</h1>
  </div>
</div>

<div class="mx-auto max-w-7xl px-5 py-10">

  <!-- Committee filter -->
  {#if data.committees.length > 0}
    <form method="get" class="mb-8 flex flex-wrap items-center gap-3">
      <label for="ausschuss-filter" class="font-mono text-[11px] tracking-widest text-ink-muted uppercase">
        Ausschuss:
      </label>
      <select
        id="ausschuss-filter"
        name="ausschuss"
        class="rounded-sm border border-ink-subtle bg-surface px-3 py-1.5 font-mono text-[12px] text-ink-2
               focus:border-ink focus:outline-hidden"
        onchange={(e) => (e.currentTarget as HTMLSelectElement).form?.submit()}
      >
        <option value="">Alle Ausschüsse</option>
        {#each data.committees as committee}
          <option
            value={String(committee.id)}
            selected={data.selectedCommitteeId === committee.id}
          >
            {committee.name}
          </option>
        {/each}
      </select>
      {#if data.selectedCommitteeId}
        <a href="{base}/beschluesse" class="font-mono text-[11px] text-[var(--ember)] uppercase hover:opacity-75 transition-opacity">
          Filter zurücksetzen ×
        </a>
      {/if}
    </form>
  {/if}

  {#if data.beschluesse.length === 0}
    <p class="font-display text-lg text-ink-muted">Keine veröffentlichten Beschlüsse gefunden.</p>
  {:else}
    <ul class="divide-y divide-ink-subtle border-t border-ink-subtle">
      {#each data.beschluesse as beschluss}
        <li class="group flex items-center justify-between gap-4 py-4">
          <a href="{base}/protokolle/{beschluss.protocol_id}" class="flex-1 min-w-0">
            <p class="font-display text-[15px] font-semibold text-ink group-hover:text-[var(--ember)] transition-colors">
              {beschluss.text}
            </p>
            <div class="mt-0.5 flex flex-wrap items-center gap-3">
              <span class="font-mono text-[11px] text-ink-muted">{beschlussNr(beschluss)}</span>
              <span class="font-mono text-[11px] text-ink-muted">{beschluss.committee_name}</span>
              <time
                datetime={new Date(beschluss.meeting_date).toISOString()}
                class="font-mono text-[11px] text-ink-muted"
              >
                {new Date(beschluss.meeting_date).toLocaleDateString('de-DE', {
                  day: '2-digit', month: 'long', year: 'numeric',
                })}
              </time>
            </div>
          </a>
          <div class="flex shrink-0 items-center gap-2">
            {#if beschluss.angefochten_count > 0}
              <!-- Anfechtung badge: a bare count only — never who or why. -->
              <span class="rounded-sm border border-[var(--ember)] px-2 py-1 font-mono text-[11px] tracking-wide text-[var(--ember)] uppercase">
                Angefochten ({beschluss.angefochten_count})
              </span>
            {/if}
            {#if beschluss.adoption_mode === 'acclamation'}
              <!-- Acclamation Beschluss: outcome declared by the chair, no tally
                   to show — never 'einstimmig', never a ja:nein:enthaltung line. -->
              <span class="rounded-sm border border-ink-subtle px-2 py-1 font-mono text-[11px] tracking-wide text-ink-2 uppercase">
                per Akklamation
              </span>
            {:else if unanimous(beschluss)}
              <span class="rounded-sm border border-ink-subtle px-2 py-1 font-mono text-[11px] tracking-wide text-ink-2 uppercase">
                einstimmig
              </span>
            {:else}
              <span class="font-mono text-[11px] text-ink-muted" title="Format ja:nein:enthaltung">
                {beschluss.votes_yes}:{beschluss.votes_no}:{beschluss.votes_abstain}
              </span>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}

</div>
