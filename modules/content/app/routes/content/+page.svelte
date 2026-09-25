<script lang="ts">
  // Content Engine authoring list. PLAIN, functional placeholder — Claude Design
  // polishes the visual layer later (this ships against the contract, not the
  // final look). Lists posts with title, last-updated, and channel chips.
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()

  function fmtDate(d: string | null): string {
    return d ? new Date(d).toLocaleDateString('de-DE') : '—'
  }

  const CHANNEL_LABELS: Record<string, string> = {
    email: 'E-Mail',
    portal: 'Portal',
    instagram: 'Instagram',
  }
</script>

<PageTitle title="Inhalte" />

<div class="head">
  <div>
    <h1>Inhalte</h1>
    <p class="sub">Einmal verfassen — als E-Mail, Portal-Beitrag und Instagram-Carousel ausspielen.</p>
  </div>
  <div class="head-actions">
    <a class="btn-ghost" href="/content/lists">Verteilerlisten</a>
    <a class="btn" href="/content/new">Neuer Inhalt</a>
  </div>
</div>

{#if data.posts.length === 0}
  <div class="empty">
    <p>Noch keine Inhalte.</p>
    <a class="btn" href="/content/new">Ersten Inhalt anlegen</a>
  </div>
{:else}
  <div class="tbl">
    <div class="row head-row">
      <div>Titel</div>
      <div>Aktualisiert</div>
      <div>Kanäle</div>
    </div>
    {#each data.posts as post (post.id)}
      <a class="row link" href="/content/{post.id}/edit">
        <div class="title">{post.title || '(ohne Titel)'}</div>
        <div class="muted">{fmtDate(post.updated_at)}</div>
        <div class="chips">
          {#if post.enabledChannels.length === 0}
            <span class="muted">—</span>
          {:else}
            {#each post.enabledChannels as ch (ch)}
              <span class="chip">{CHANNEL_LABELS[ch] ?? ch}</span>
            {/each}
          {/if}
        </div>
      </a>
    {/each}
  </div>
{/if}

<style>
  .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
  h1 { font-size: 26px; font-weight: 600; }
  .sub { color: var(--ink-muted, #666); font-size: 13px; margin-top: 4px; max-width: 560px; }
  .btn { display: inline-block; padding: 7px 14px; border: 1px solid var(--border, #ccc); border-radius: 6px; font-size: 13px; text-decoration: none; color: inherit; background: var(--surface-2, #f5f5f5); }
  .btn:hover { background: var(--surface-3, #ececec); }
  .head-actions { display: flex; gap: 8px; align-items: center; }
  .btn-ghost { display: inline-block; padding: 7px 14px; border: 1px solid var(--border, #ccc); border-radius: 6px; font-size: 13px; text-decoration: none; color: inherit; background: transparent; }
  .btn-ghost:hover { background: var(--surface-2, #f5f5f5); }
  .empty { text-align: center; padding: 48px 16px; color: var(--ink-muted, #666); display: flex; flex-direction: column; gap: 14px; align-items: center; }
  .tbl { border: 1px solid var(--border, #ddd); border-radius: 8px; overflow: hidden; }
  .row { display: grid; grid-template-columns: 1fr 140px 240px; gap: 12px; align-items: center; padding: 11px 14px; border-bottom: 1px solid var(--border, #eee); font-size: 13px; color: inherit; text-decoration: none; }
  .row:last-child { border-bottom: none; }
  .head-row { background: var(--surface-2, #f5f5f5); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-muted, #666); }
  .link:hover { background: var(--surface-2, #f7f7f7); }
  .title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .muted { color: var(--ink-muted, #888); }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--surface-3, #eef); border: 1px solid var(--border, #dde); }
</style>
