<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { LayoutData } from './$types'

  let { data, children }: { data: LayoutData; children: Snippet } = $props()
</script>

<div class="shell">
  <header>
    <a class="brand" href="/">Gremion Betrieb</a>
    <nav aria-label="Hauptnavigation">
      <a href="/">Mandanten</a>
      <a href="/customers/new">Neuer Mandant</a>
      <a href="/betrieb">Betrieb</a>
    </nav>
    <p class="who">
      Angemeldet als <strong>{data.operator.email ?? 'Operator'}</strong>
      <span class="acr" title="Anmeldestufe">({data.operator.acr})</span>
    </p>
  </header>
  <main>
    {@render children()}
  </main>
</div>

<style>
  :global(:root) {
    --bg: #f6f5f2;
    --fg: #1d1f21;
    --muted: #5b6168;
    --line: #d8d5cf;
    --accent: #2f5d50;
    --warn: #8a4b00;
    --bad: #9b1c1c;
    --ok: #1f6b3a;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --bg: #16181a;
      --fg: #e7e5e0;
      --muted: #a3a8ad;
      --line: #33373b;
      --accent: #7fb8a6;
      --warn: #e0a458;
      --bad: #f08c8c;
      --ok: #86c79d;
    }
  }
  :global(body) {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font: 15px/1.5 system-ui, sans-serif;
  }
  .shell {
    max-width: 72rem;
    margin: 0 auto;
    padding: 0 1rem 3rem;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem 2rem;
    align-items: baseline;
    border-bottom: 1px solid var(--line);
    padding: 1rem 0;
  }
  .brand {
    font-weight: 700;
    color: var(--fg);
    text-decoration: none;
  }
  nav {
    display: flex;
    gap: 1rem;
  }
  nav a {
    color: var(--accent);
  }
  .who {
    margin: 0 0 0 auto;
    color: var(--muted);
  }
  .acr {
    font-variant-numeric: tabular-nums;
  }
</style>
