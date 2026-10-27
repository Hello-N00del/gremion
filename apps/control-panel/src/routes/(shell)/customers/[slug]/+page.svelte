<script lang="ts">
  import { enhance } from '$app/forms'
  import { originLabel } from '$lib/request-format'
  import { LEDGER_STEP_LABEL as STEP_LABEL } from '$lib/request-state'
  import type { ActionData, PageData } from './$types'

  let { data, form }: { data: PageData; form: ActionData } = $props()

  const STATUS_LABEL: Record<string, string> = { done: 'erledigt', pending: 'ausstehend', failed: 'fehlgeschlagen', absent: '—' }
  // No script polls: while a request or the setup is active the page reloads itself
  // (meta refresh, allowed by the panel's CSP), and the link reloads on demand.
</script>

<svelte:head>
  <title>{data.slug} · Gremion Betrieb</title>
  {#if data.refresh}<meta http-equiv="refresh" content="5" />{/if}
</svelte:head>

<h1>{data.slug}</h1>

{#if data.latest}
  <section class="request {data.latest.phase}" aria-labelledby="req-h">
    <h2 id="req-h">Anfrage: <span class="phase">{data.latest.label}</span></h2>
    <p role="status">{data.latest.text}</p>
    {#if data.latest.code}<p class="muted">Fehlerkennung: <code>{data.latest.code}</code></p>{/if}
    {#if data.latest.detail}<p class="muted">Begründung (technisch): <code>{data.latest.detail}</code></p>{/if}
    {#if data.latest.active}<p class="muted">Diese Seite lädt sich alle 5 Sekunden neu. <a href="/customers/{data.slug}">Jetzt aktualisieren</a></p>{/if}
    {#if data.latest.retryable}
      <form method="POST" action="?/retry" use:enhance>
        {#if form?.retryError}<p class="error" role="alert">{form.retryError}</p>{/if}
        <button type="submit">Erneut versuchen</button>
      </form>
    {:else if data.latest.retryNote}
      <p class="muted">{data.latest.retryNote}</p>
    {/if}
  </section>
{/if}

{#if !data.status}
  {#if !data.latest}<p class="muted" role="status">Noch keine Anfrage und kein Mandant mit diesem Kurznamen.</p>{/if}
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
  .request {
    max-width: 36rem;
    border: 1px solid var(--line);
    border-left-width: 4px;
    padding: 0.5rem 1rem;
    margin-bottom: 1.5rem;
  }
  .request h2 {
    font-size: 1.1rem;
  }
  .request.succeeded {
    border-left-color: var(--ok);
  }
  .request.failed,
  .request.refused,
  .request.dead {
    border-left-color: var(--bad);
  }
  .request.queued,
  .request.verifying,
  .request.running,
  .request.expired {
    border-left-color: var(--warn);
  }
  .error {
    color: var(--bad);
  }
  .muted {
    color: var(--muted);
  }
</style>
