<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData } from './$types'
  import Icon from '$lib/components/ui/Icon.svelte'
  import NewPostDialog from '$lib/components/news/NewPostDialog.svelte'

  let { data }: { data: PageData } = $props()
  let error = $state('')
  let dialogOpen = $state(false)
  let creating = $state(false)

  // Counts are derivable client-side (published = has a published_at).
  const published = $derived(data.posts.filter((p) => p.published_at).length)
  const drafts = $derived(data.posts.length - published)

  function fmtDate(d: Date | string | null): string {
    return d ? new Date(d).toLocaleDateString('de-DE') : '—'
  }

  function openCreate() {
    error = ''
    dialogOpen = true
  }

  async function createPost(title: string) {
    error = ''
    creating = true
    try {
      const res = await fetch('/api/news', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      })
      if (res.ok) {
        const post = await res.json()
        window.location.href = `/news/${post.id}/edit`
      } else {
        dialogOpen = false
        error = 'Beitrag konnte nicht erstellt werden.'
      }
    } catch {
      dialogOpen = false
      error = 'Verbindungsfehler. Bitte erneut versuchen.'
    } finally {
      creating = false
    }
  }
</script>

<PageTitle title="Veröffentlichungen" />

<div class="page-head">
  <div>
    <div class="eyebrow">News-Redaktion · stura-public</div>
    <h1 class="page-title">Veröffentlichungen</h1>
    <div class="page-sub">
      {published} veröffentlicht · {drafts} {drafts === 1 ? 'Entwurf' : 'Entwürfe'} · Wird im öffentlichen Portal angezeigt.
    </div>
  </div>
  <button type="button" class="btn btn-primary btn-sm" onclick={openCreate}>
    <Icon name="plus" size={13} /> Beitrag
  </button>
</div>

<NewPostDialog
  open={dialogOpen}
  busy={creating}
  onClose={() => (dialogOpen = false)}
  onSubmit={createPost}
/>

{#if error}
  <div class="news-error" role="alert">{error}</div>
{/if}

{#if data.posts.length === 0}
  <div class="empty-state">
    <div class="glyph"><Icon name="newspaper" size={22} /></div>
    <div class="ttl">Keine Veröffentlichungen</div>
    <div class="sub">Lege einen Beitrag an — er erscheint nach Freigabe im öffentlichen Portal.</div>
  </div>
{:else}
  <div class="card tbl">
    <div class="tbl-row tbl-head">
      <div>Titel</div>
      <div>Autor·in · Gremium</div>
      <div>Veröffentlicht</div>
      <div>Status</div>
      <div class="ta-right">Aufrufe</div>
    </div>
    {#each data.posts as post (post.id)}
      <a class="tbl-row tbl-link" href="/news/{post.id}/edit">
        <div class="td-primary td-trunc">{post.title}</div>
        <div class="td-author">
          <div class="td-name td-trunc">{post.authorLabel}</div>
          <div class="mono td-gremium">—</div>
        </div>
        <div class="mono td-muted">{fmtDate(post.published_at)}</div>
        <div>
          {#if post.published_at}
            <span class="pill pill-success"><Icon name="check" size={11} /> Live</span>
          {:else}
            <span class="pill pill-warn"><Icon name="alert-triangle" size={11} /> Entwurf</span>
          {/if}
        </div>
        <div class="mono td-views ta-right">—</div>
      </a>
    {/each}
  </div>
{/if}

<style>
  .page-head {
    display: flex; justify-content: space-between; align-items: flex-end;
    margin-bottom: 24px; gap: 20px; flex-wrap: wrap;
  }
  .page-title {
    font-family: var(--font-display); font-size: 30px; font-weight: 500;
    letter-spacing: -0.015em; line-height: 1.1;
  }
  .page-sub { color: var(--ink-muted); font-size: 13.5px; margin-top: 6px; max-width: 620px; }

  .tbl { overflow: hidden; }
  .tbl-row {
    display: grid; grid-template-columns: 1fr 200px 120px 100px 80px; gap: 12px; align-items: center;
    padding: 11px 16px; border-bottom: 1px solid var(--border);
    font-size: 13px; text-decoration: none; color: var(--ink);
  }
  .tbl-row:last-child { border-bottom: none; }
  .tbl-head { background: var(--surface-2); font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-muted); }
  .tbl-link { transition: background var(--d-fast); }
  .tbl-link:hover { background: var(--surface-2); }
  .td-primary { font-weight: 500; }
  .td-muted { color: var(--ink-muted); font-size: 12px; }
  .td-trunc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .td-author { min-width: 0; }
  .td-name { font-size: 13px; }
  .td-gremium { font-size: 10.5px; color: var(--ink-muted); margin-top: 2px; }
  .td-views { font-size: 12px; color: var(--ink-faint); }
  .ta-right { text-align: right; }

  .news-error {
    margin-bottom: 16px; padding: 10px 14px; border-radius: 8px;
    background: var(--rust-soft); color: var(--rust-ink);
    font-size: 13px;
  }
</style>
