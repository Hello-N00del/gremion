<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import Icon from '$lib/components/ui/Icon.svelte'
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()

  // v5 Task 4.1 — newsletter issue-card grid (prototype: screens-v4.jsx:293-342).
  // Status pills + German labels are rendered inline below per status branch.
  function fmtDate(d: string | null): string {
    return d ? new Date(d).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
  }
</script>

<PageTitle title="Newsletter" />

<div class="page-head">
  <div>
    <div class="eyebrow">Newsletter · Mailing</div>
    <h1 class="page-title">Ausgaben</h1>
    <div class="page-sub">
      {data.newsletters.length}
      {data.newsletters.length === 1 ? 'Ausgabe' : 'Ausgaben'} ·
      {data.subscriberCount} Abonnent·innen · Versand über Mailman 3
    </div>
  </div>
  <a href="/newsletter/new" class="btn btn-primary btn-sm">
    <Icon name="plus" size={14} /> Neue Ausgabe
  </a>
</div>

{#if data.newsletters.length === 0}
  <div class="empty-state">
    <div class="glyph"><Icon name="mail" size={22} /></div>
    <div class="ttl">Noch keine Ausgaben</div>
    <div class="sub">Lege eine Ausgabe an — sie wird über Mailman 3 an die Verteilerlisten versandt.</div>
  </div>
{:else}
  <div class="grid-3">
    {#each data.newsletters as n (n.id)}
      <div class="card card-pad nl-card">
        <div class="nl-card-top">
          <div class="nl-card-id">
            <div class="nl-title">{n.title}</div>
            <div class="mono nl-meta">
              #{n.id}{#if n.scheduled_at} · geplant {fmtDate(n.scheduled_at)}{/if}
            </div>
          </div>
          {#if n.status === 'sent'}
            <span class="pill pill-success">Versandt</span>
          {:else if n.status === 'scheduled'}
            <span class="pill pill-warn">Geplant</span>
          {:else if n.status === 'sending'}
            <span class="pill pill-warn">Wird gesendet</span>
          {:else if n.status === 'failed'}
            <span class="pill pill-danger">Fehler</span>
          {:else}
            <span class="pill">Entwurf</span>
          {/if}
        </div>

        <div class="nl-stats">
          <div class="nl-stat">
            <span class="lbl">Empfänger</span>
            <span class="mono val">{n.recipientCount}</span>
          </div>
          {#if n.status === 'sent' && n.open_rate != null}
            <div class="nl-stat">
              <span class="lbl">Öffnungsrate</span>
              <span class="mono val pine">{Math.round(n.open_rate * 100)} %</span>
            </div>
          {:else if n.status === 'sent'}
            <div class="nl-stat">
              <span class="lbl">Öffnungsrate</span>
              <span class="mono val muted">—</span>
            </div>
          {/if}
        </div>

        <div class="nl-actions">
          <a class="btn btn-sm btn-ghost nl-grow" href="/newsletter/{n.id}{n.status === 'draft' ? '' : '/preview'}">
            {n.status === 'draft' ? 'Bearbeiten' : 'Vorschau'}
          </a>
          {#if n.status !== 'sent' && n.status !== 'sending'}
            <a class="btn btn-sm btn-primary" href="/newsletter/{n.id}">Senden</a>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}

<div class="nl-lists">
  <div class="nl-lists-head">
    <h2>Verteilerlisten</h2>
    <a href="/newsletter/lists" class="nl-lists-link">Verwalten →</a>
  </div>
  <p class="nl-lists-sub">{data.lists.length} {data.lists.length === 1 ? 'Liste' : 'Listen'} vorhanden</p>
</div>

<style>
  .page-head {
    display: flex; justify-content: space-between; align-items: flex-end;
    margin-bottom: 4px; gap: 20px; flex-wrap: wrap;
  }
  .page-title {
    font-family: var(--font-display); font-size: 30px; font-weight: 500;
    letter-spacing: -0.015em; line-height: 1.1;
  }
  .page-sub { color: var(--ink-muted); font-size: 13.5px; margin-top: 6px; max-width: 620px; }

  .nl-card { display: flex; flex-direction: column; }
  .nl-card-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
  .nl-card-id { flex: 1; min-width: 0; }
  .nl-title {
    font-family: var(--font-display); font-size: 15px; font-weight: 600;
    letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .nl-meta { font-size: 10.5px; color: var(--ink-muted); margin-top: 4px; }

  .nl-stats {
    margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border);
    display: flex; flex-direction: column; gap: 4px;
  }
  .nl-stat { display: flex; justify-content: space-between; font-size: 11.5px; }
  .nl-stat .lbl { color: var(--ink-muted); }
  .nl-stat .val { font-size: 12px; }
  .nl-stat .val.pine { color: var(--pine); }
  .nl-stat .val.muted { color: var(--ink-faint); }

  .nl-actions { display: flex; gap: 6px; margin-top: 14px; }
  .nl-grow { flex: 1; justify-content: center; }

  .nl-lists { margin-top: 32px; }
  .nl-lists-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
  .nl-lists-head h2 { font-family: var(--font-display); font-size: 16px; font-weight: 600; }
  .nl-lists-link { font-size: 13px; color: var(--accent-ink); text-decoration: none; }
  .nl-lists-link:hover { text-decoration: underline; }
  .nl-lists-sub { font-size: 13px; color: var(--ink-muted); margin-top: 4px; }
</style>
