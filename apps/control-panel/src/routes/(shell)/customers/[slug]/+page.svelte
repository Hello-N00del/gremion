<script lang="ts">
  import { invalidateAll } from '$app/navigation'
  import { onMount } from 'svelte'
  import { originLabel } from '$lib/request-format'
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()

  const STEP_LABEL: Record<string, string> = {
    realm_created: 'Anmelde-Realm angelegt',
    database_created: 'Kerndatenbank angelegt und migriert',
    domain_bound: 'Host gebunden (DNS geprüft)',
    storage_prefix_reserved: 'Speicherbereich reserviert',
    first_body_created: 'Erstes Gremium angelegt',
    broker_account_created: 'Broker-Konto angelegt',
    mail_principal_issued: 'Eigener Mail-Absender ausgestellt',
    first_accounts_created: 'Erste Verwaltungskonten eingeladen',
  }
  const STATUS_LABEL: Record<string, string> = { done: 'erledigt', pending: 'ausstehend', failed: 'fehlgeschlagen', absent: '—' }

  // While the customer is still being set up, re-read the ledger every 5 s.
  onMount(() => {
    const t = setInterval(() => {
      if (!data.status || data.status.status === 'provisioning') void invalidateAll()
    }, 5000)
    return () => clearInterval(t)
  })
</script>

<svelte:head><title>{data.slug} · Gremion Betrieb</title></svelte:head>

<h1>{data.slug}</h1>

{#if !data.status}
  <p class="muted" role="status">Noch nicht registriert. Sobald der Ausführer die Anfrage übernimmt und Phase A beginnt, erscheint der Mandant hier.</p>
{:else}
  <dl>
    <dt>Status</dt><dd>{data.status.status}</dd>
    <dt>Host</dt><dd>{data.status.host ?? '—'}</dd>
    <dt>Kennung</dt><dd><code>{data.status.id}</code></dd>
  </dl>
  {#if data.status.steps === null}
    <p class="muted">Keine Plattform-Datenbank konfiguriert: der Einrichtungsverlauf ist hier nicht lesbar.</p>
  {:else}
    <ol class="steps">
      {#each data.status.steps as s (s.kind)}
        <li class={s.status}>
          <span class="label">{STEP_LABEL[s.kind] ?? s.kind}</span>
          <span class="state">{STATUS_LABEL[s.status]}</span>
        </li>
      {/each}
    </ol>
  {/if}
{/if}

{#if data.requests.length}
  <h2>Anfragen</h2>
  <ul class="requests">
    {#each data.requests as q (q.id)}
      <li>
        <code>{q.kind}</code> · {q.state}
        {#if q.origin === 'host'}<strong class="breakglass">{originLabel(q.origin)}</strong> ({q.hostActor ?? '—'}: {q.reason ?? '—'}){/if}
        {#if q.outcome}<span class="muted"> — {q.outcome}</span>{/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  h1 {
    font-size: 1.4rem;
    margin: 1.5rem 0 1rem;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
  }
  dt {
    color: var(--muted);
  }
  .steps {
    padding-left: 1.25rem;
  }
  .steps li {
    display: flex;
    justify-content: space-between;
    max-width: 36rem;
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--line);
  }
  .steps li.done .state {
    color: var(--ok);
  }
  .steps li.failed .state {
    color: var(--bad);
  }
  .steps li.pending .state {
    color: var(--warn);
  }
  .muted {
    color: var(--muted);
  }
</style>
