<script lang="ts">
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()

  const STATUS_LABEL: Record<string, string> = {
    provisioning: 'Wird eingerichtet',
    active: 'Aktiv',
    suspended: 'Gesperrt',
    deleting: 'Wird gelöscht',
    deleted: 'Gelöscht',
  }
</script>

<svelte:head><title>Mandanten · Gremion Betrieb</title></svelte:head>

<h1>Mandanten</h1>

{#if data.error}
  <p class="notice bad" role="alert">{data.error}</p>
{/if}

{#if data.newCustomerDisabled}
  <p class="notice warn">„Neuer Mandant“ ist hier deaktiviert: {data.newCustomerDisabled}</p>
{/if}

{#if data.customers.length === 0 && !data.error}
  <p class="empty">Noch kein Mandant. Ein Mandant entsteht mit <code>gremion-tenant create</code>.</p>
{:else if data.customers.length > 0}
  <table>
    <thead>
      <tr><th scope="col">Kurzname</th><th scope="col">Host</th><th scope="col">Status</th><th scope="col">Einrichtung</th></tr>
    </thead>
    <tbody>
      {#each data.customers as c (c.id)}
        <tr>
          <td><a href={`/customers/${c.slug}`}>{c.slug}</a></td>
          <td>{c.host ?? '—'}</td>
          <td><span class={`status ${c.status}`}>{STATUS_LABEL[c.status] ?? c.status}</span></td>
          <td>{c.stepsDone === null ? 'keine Plattform-DB' : `${c.stepsDone} / 8 Schritte`}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  h1 {
    font-size: 1.4rem;
    margin: 1.5rem 0 1rem;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th,
  td {
    text-align: left;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--line);
  }
  th {
    color: var(--muted);
    font-weight: 600;
  }
  td a {
    color: var(--accent);
  }
  .status.active {
    color: var(--ok);
  }
  .status.suspended,
  .status.deleting,
  .status.deleted {
    color: var(--bad);
  }
  .status.provisioning {
    color: var(--warn);
  }
  .notice {
    border: 1px solid var(--line);
    padding: 0.75rem 1rem;
  }
  .notice.warn {
    color: var(--warn);
  }
  .notice.bad {
    color: var(--bad);
  }
  .empty {
    color: var(--muted);
  }
</style>
