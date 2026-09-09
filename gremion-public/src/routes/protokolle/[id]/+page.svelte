<script lang="ts">
  import { base } from '$app/paths';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>{data.protocol.committee_name} · Protokoll {new Date(data.protocol.meeting_date).toLocaleDateString('de-DE')} — Studierendenrat</title>
</svelte:head>

<!-- Page header -->
<div class="border-b border-ink-subtle bg-surface">
  <div class="mx-auto max-w-4xl px-5 py-10">
    <a
      href="{base}/protokolle"
      class="mb-4 inline-block font-mono text-[11px] tracking-wide text-ink-muted uppercase hover:text-[var(--ember)] transition-colors"
    >
      ← Alle Protokolle
    </a>
    <h1 class="font-display text-4xl font-bold leading-tight text-ink">
      {data.protocol.committee_name}
    </h1>
    <div class="mt-3 flex flex-wrap items-center gap-4">
      <time
        datetime={new Date(data.protocol.meeting_date).toISOString()}
        class="font-mono text-[11px] text-ink-muted"
      >
        {new Date(data.protocol.meeting_date).toLocaleDateString('de-DE', {
          weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
        })}
      </time>
      <!-- `pdf_url` is a root-relative path from public-db.ts — base-prefix it. -->
      {#if data.protocol.pdf_url}
        <a
          href="{base}{data.protocol.pdf_url}"
          class="rounded-sm bg-ink px-4 py-1.5 font-mono text-[11px] font-medium tracking-wider text-white uppercase hover:opacity-80 transition-opacity"
          download
        >
          PDF herunterladen ↓
        </a>
      {/if}
    </div>
  </div>
</div>

<div class="mx-auto max-w-4xl px-5 py-10">
  <div class="prose prose-neutral max-w-none rounded-md border border-ink-subtle bg-surface p-8 text-ink
              prose-headings:font-display prose-headings:text-ink prose-a:text-[var(--ember)]
              prose-a:no-underline hover:prose-a:underline">
    <!-- Sanitised protocol HTML -->
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {@html data.protocol.body_html}
  </div>
</div>
