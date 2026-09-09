<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()
</script>

<PageTitle title="Löschkonzept" />
<svelte:head>
  <style>
    @media print {
      body { font-size: 11pt; }
      .no-print { display: none; }
    }
  </style>
</svelte:head>

<div class="mx-auto max-w-3xl px-8 py-10">
  <div class="no-print mb-6 flex items-center gap-4">
    <button
      onclick={() => window.print()}
      class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-paper hover:bg-accent/90"
    >
      Drucken / Als PDF speichern
    </button>
    <a href="/settings/compliance" class="text-sm text-ink-muted hover:underline">← Zurück</a>
  </div>

  <pre class="whitespace-pre-wrap font-mono text-sm leading-relaxed">{data.document}</pre>
</div>
