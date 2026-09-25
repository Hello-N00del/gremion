<script lang="ts">
  import type { PageData } from './$types';
  import { enhance } from '$app/forms';
  import { untrack } from 'svelte';
  import { t } from '$lib/i18n';
  import RichTextComposer from '$lib/components/news/RichTextComposer.svelte';

  let { data }: { data: PageData } = $props();

  // Native composer fallback — used when Collabora is unavailable so the
  // body can still be authored. Seeds from the stored (already-sanitized)
  // body_html; PATCHes the same body_html field the public portal renders.
  let body = $state(untrack(() => data.post.body_html ?? ''));
  let composerSaving = $state(false);
  let composerError = $state('');
  let composerSaved = $state(false);

  async function saveComposer() {
    composerSaving = true;
    composerError = '';
    composerSaved = false;
    try {
      const res = await fetch(`/api/news/${data.post.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body_html: body }),
      });
      if (!res.ok) throw new Error();
      composerSaved = true;
    } catch {
      composerError = $t('news.composer.saveError');
    } finally {
      composerSaving = false;
    }
  }
</script>

<svelte:head><title>{data.post.title} — Bearbeiten</title></svelte:head>

<div class="flex flex-col h-screen">
  <div class="flex items-center gap-3 px-6 py-3 border-b bg-paper">
    <a href="/news" class="text-sm text-ink-muted hover:underline">← Neuigkeiten</a>
    <h1 class="font-semibold flex-1 truncate">{data.post.title}</h1>

    <form method="POST" action="?/save" use:enhance>
      <button
        type="submit"
        class="inline-flex items-center px-3 py-1.5 text-sm border rounded-md hover:bg-surface-2 transition-colors"
      >
        Speichern
      </button>
    </form>

    {#if data.post.published_at}
      <form method="POST" action="?/unpublish" use:enhance>
        <button
          type="submit"
          class="inline-flex items-center px-3 py-1.5 text-sm bg-surface-2 text-ink rounded-md hover:bg-surface-2/80 transition-colors"
        >
          Zurückziehen
        </button>
      </form>
    {:else}
      <form method="POST" action="?/publish" use:enhance>
        <button
          type="submit"
          class="inline-flex items-center px-3 py-1.5 text-sm bg-accent text-paper rounded-md hover:bg-accent/90 transition-colors"
        >
          Veröffentlichen
        </button>
      </form>
    {/if}
  </div>

  {#if data.editorUrl}
    <iframe
      src={data.editorUrl}
      class="flex-1 border-0"
      title="Collabora Editor"
      allow="camera; microphone; clipboard-read; clipboard-write"
    ></iframe>
  {:else}
    <div class="flex-1 flex flex-col gap-3 overflow-y-auto p-6">
      <p class="text-sm text-ink-muted">{$t('news.composer.collaboraUnavailable')}</p>
      <div class="flex items-center gap-3">
        <button
          type="button"
          onclick={saveComposer}
          disabled={composerSaving}
          class="inline-flex items-center px-3 py-1.5 text-sm border rounded-md hover:bg-surface-2 transition-colors disabled:opacity-50"
        >
          {composerSaving ? $t('news.composer.saving') : $t('news.composer.save')}
        </button>
        {#if composerSaved}
          <span class="text-sm text-ink-muted">{$t('news.composer.saved')}</span>
        {/if}
        {#if composerError}
          <span class="text-sm text-rust" role="alert">{composerError}</span>
        {/if}
      </div>
      <RichTextComposer bind:value={body} ariaLabel={$t('news.composer.body')} />
    </div>
  {/if}
</div>
