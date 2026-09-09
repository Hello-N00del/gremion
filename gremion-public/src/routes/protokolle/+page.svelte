<script lang="ts">
  import { base } from '$app/paths';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>Protokolle — Studierendenrat</title>
  <meta name="description" content="Veröffentlichte Protokolle der Ausschüsse des Studierendenrats." />
</svelte:head>

<!-- Page header -->
<div class="border-b border-ink-subtle bg-surface">
  <div class="mx-auto max-w-7xl px-5 py-10">
    <p class="mb-2 font-mono text-[10px] tracking-widest text-ink-muted uppercase">Transparenz</p>
    <h1 class="font-display text-4xl font-bold text-ink">Protokolle</h1>
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
        <a href="{base}/protokolle" class="font-mono text-[11px] text-[var(--ember)] uppercase hover:opacity-75 transition-opacity">
          Filter zurücksetzen ×
        </a>
      {/if}
    </form>
  {/if}

  {#if data.protocols.length === 0}
    <p class="font-display text-lg text-ink-muted">Keine veröffentlichten Protokolle gefunden.</p>
  {:else}
    <ul class="divide-y divide-ink-subtle border-t border-ink-subtle">
      {#each data.protocols as protocol}
        <li class="group flex items-center justify-between gap-4 py-4">
          <a href="{base}/protokolle/{protocol.id}" class="flex-1 min-w-0">
            <p class="font-display text-[15px] font-semibold text-ink group-hover:text-[var(--ember)] transition-colors">
              {protocol.title ?? protocol.committee_name}
            </p>
            <div class="mt-0.5 flex flex-wrap items-center gap-3">
              <span class="font-mono text-[11px] text-ink-muted">{protocol.committee_name}</span>
              <time
                datetime={new Date(protocol.meeting_date).toISOString()}
                class="font-mono text-[11px] text-ink-muted"
              >
                {new Date(protocol.meeting_date).toLocaleDateString('de-DE', {
                  day: '2-digit', month: 'long', year: 'numeric',
                })}
              </time>
            </div>
          </a>
          <!-- `pdf_url` is a root-relative path from public-db.ts — base-prefix it. -->
          {#if protocol.pdf_url}
            <a
              href="{base}{protocol.pdf_url}"
              class="shrink-0 rounded-sm border border-ink-subtle px-3 py-1.5 font-mono text-[11px] tracking-wide
                     text-ink-2 uppercase hover:border-ink hover:text-ink transition-colors"
              download
              aria-label="PDF herunterladen für {protocol.committee_name}"
            >
              PDF ↓
            </a>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

</div>
