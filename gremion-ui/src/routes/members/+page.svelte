<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData } from './$types'
  import { t } from '$lib/i18n'

  let { data }: { data: PageData } = $props()

  let roleFilter = $state<string>('Alle')
  let selected = $state<PageData['members'][number] | null>(null)

  // design roleHue (contracts.jsx): role-tag accent per friendly role.
  const roleHue: Record<string, number> = {
    Vorstand: 300,
    Finanzen: 52,
    Admin: 29,
    'IT-Team': 205,
    Mitglied: 252,
  }

  const allRoles = $derived(['Alle', ...new Set(data.members.flatMap((m) => m.roles))])
  const shown = $derived(
    roleFilter === 'Alle' ? data.members : data.members.filter((m) => m.roles.includes(roleFilter)),
  )

  function initials(name: string): string {
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0] ?? '')
      .join('')
      .toUpperCase()
  }

  async function toggleEnabled(handle: string, enabled: boolean) {
    // #208: only update the row after the PATCH actually succeeds — otherwise a
    // failed request would leave the UI showing a state the server never took.
    const res = await fetch(`/api/members/${handle}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    if (!res.ok) {
      alert('Status der Person konnte nicht geändert werden.')
      return
    }
    const m = data.members.find((x) => x.id === handle)
    if (m) m.enabled = enabled
  }
</script>

<PageTitle title="Mitglieder" />

<div class="page-head">
  <div>
    <div class="eyebrow">Verwaltung</div>
    <h1 class="page-title">Mitglieder</h1>
    <div class="page-sub">
      {data.members.length}
      {data.members.length === 1 ? 'Person' : 'Personen'}
    </div>
  </div>
</div>

{#if data.isAdmin}
  <div class="filter-row">
    {#each allRoles as r (r)}
      <button class="chip" class:active={roleFilter === r} onclick={() => (roleFilter = r)}>{r}</button>
    {/each}
  </div>
{/if}

{#if shown.length === 0}
  <div class="empty-state">
    <div class="ttl">Keine Mitglieder</div>
    <div class="sub">Sobald Personen Gremien zugeordnet sind, erscheinen sie hier.</div>
  </div>
{:else}
  <ul class="member-list">
    {#each shown as m (m.id)}
      <li class="member-row" class:disabled={!m.enabled}>
        <button class="member-main" onclick={() => (selected = m)}>
          <span class="mav">{initials(m.name)}</span>
          <span class="who">
            <span class="member-name">{m.name}</span>
            <span class="member-email">{m.email}</span>
          </span>
          <span class="role-tags">
            {#each m.roles as r (r)}
              <span class="role-tag" style="--c-hue: {roleHue[r] ?? 252};">{r}</span>
            {/each}
          </span>
          {#if data.isAdmin}
            <span class="status mono" class:off={!m.enabled}>{m.enabled ? $t('members.status.active') : $t('members.status.inactive')}</span>
          {/if}
        </button>
        {#if data.isAdmin}
          <label class="toggle">
            <input
              type="checkbox"
              checked={m.enabled}
              onchange={(e) => toggleEnabled(m.id, (e.currentTarget as HTMLInputElement).checked)}
            />
            {$t('members.accountActive')}
          </label>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

{#if selected}
  <button class="scrim" aria-label="Schließen" onclick={() => (selected = null)}></button>
  <aside class="detail-slideover" aria-label="Mitglied-Detail">
    <button class="close" onclick={() => (selected = null)} aria-label="Schließen">✕</button>
    <div class="detail-head">
      <span class="mav lg">{initials(selected.name)}</span>
      <div>
        <h3>{selected.name}</h3>
        <div class="member-email">{selected.email}</div>
      </div>
    </div>

    <div class="role-tags">
      {#each selected.roles as r (r)}
        <span class="role-tag" style="--c-hue: {roleHue[r] ?? 252};">{r}</span>
      {/each}
    </div>

    {#if selected.scopes.length}
      <div class="block">
        <div class="block-label mono">Berechtigungen</div>
        <div class="scope-pills">
          {#each selected.scopes as s (s)}
            <span class="scope-pill">{s}</span>
          {/each}
        </div>
      </div>
    {/if}

    {#if selected.memberships.length}
      <div class="block">
        <div class="block-label mono">Gremien &amp; Referate</div>
        {#each selected.memberships as ms (ms.ou_key)}
          <div class="ms-row">
            <span>{ms.gremium_or_referat_name}</span>
            <span class="mono ms-meta">{ms.role}{#if ms.term} · {ms.term}{/if}</span>
          </div>
        {/each}
      </div>
    {/if}
  </aside>
{/if}

<style>
  /* Generic primitives (.eyebrow, .mono, .empty-state) come from app.css; all
     values resolve to design tokens so .dark auto-switches. */
  .page-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    margin-bottom: 22px;
    gap: 20px;
    flex-wrap: wrap;
  }
  .page-title {
    font-family: var(--font-display);
    font-size: 30px;
    font-weight: 500;
    letter-spacing: -0.015em;
    line-height: 1.1;
  }
  .page-sub {
    color: var(--ink-muted);
    font-size: 13.5px;
    margin-top: 6px;
  }

  .filter-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 18px;
  }
  .chip {
    appearance: none;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--ink-2);
    border-radius: 999px;
    padding: 6px 14px;
    min-height: 32px;
    font-size: 12.5px;
    cursor: pointer;
  }
  .chip.active {
    background: var(--accent-soft);
    color: var(--accent-ink);
    border-color: transparent;
  }

  .member-list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    background: var(--surface);
  }
  .member-row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
  }
  .member-row:last-child {
    border-bottom: none;
  }
  .member-row.disabled {
    opacity: 0.55;
  }
  .member-main {
    appearance: none;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    flex: 1;
    min-width: 0;
    display: grid;
    grid-template-columns: 32px minmax(0, 1.4fr) minmax(0, 1.4fr) auto;
    gap: 14px;
    align-items: center;
    min-height: 44px;
    color: var(--ink);
  }
  .mav {
    display: inline-grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: var(--surface-3);
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    flex-shrink: 0;
  }
  .mav.lg {
    width: 44px;
    height: 44px;
    font-size: 14px;
  }
  .who {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .member-name {
    font-weight: 500;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .member-email {
    color: var(--ink-muted);
    font-size: 11.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .role-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .role-tag {
    font-size: 10.5px;
    line-height: 1;
    padding: 4px 8px;
    border-radius: 999px;
    background: oklch(95% 0.04 var(--c-hue, 252));
    color: oklch(40% 0.13 var(--c-hue, 252));
    white-space: nowrap;
  }
  :global(.dark) .role-tag {
    background: oklch(30% 0.06 var(--c-hue, 252));
    color: oklch(82% 0.12 var(--c-hue, 252));
  }
  .status {
    font-size: 10.5px;
    color: var(--ink-2);
    justify-self: end;
  }
  .status.off {
    color: var(--ink-faint);
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: var(--ink-muted);
    min-height: 44px;
    cursor: pointer;
    white-space: nowrap;
  }

  .scrim {
    position: fixed;
    inset: 0;
    background: oklch(20% 0 0 / 0.35);
    border: none;
    cursor: pointer;
    z-index: 40;
  }
  .detail-slideover {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(420px, 92vw);
    background: var(--surface);
    border-left: 1px solid var(--border);
    padding: 24px;
    overflow-y: auto;
    z-index: 41;
    box-shadow: -12px 0 32px oklch(20% 0 0 / 0.12);
  }
  .close {
    position: absolute;
    top: 16px;
    right: 16px;
    appearance: none;
    background: none;
    border: none;
    font-size: 16px;
    color: var(--ink-muted);
    cursor: pointer;
    width: 44px;
    height: 44px;
  }
  .detail-head {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
  }
  .detail-head h3 {
    font-family: var(--font-display);
    font-size: 19px;
    font-weight: 500;
    margin: 0;
  }
  .block {
    margin-top: 20px;
  }
  .block-label {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-muted);
    margin-bottom: 8px;
  }
  .scope-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .scope-pill {
    font-size: 11.5px;
    padding: 4px 10px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  .ms-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .ms-row:last-child {
    border-bottom: none;
  }
  .ms-meta {
    font-size: 11px;
    color: var(--ink-muted);
    white-space: nowrap;
  }
</style>
