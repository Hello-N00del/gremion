<script lang="ts">
  import Icon from '$lib/components/ui/Icon.svelte'

  let { domain }: { domain: string } = $props()
</script>

<!-- External services -->
<div class="services">
  <div class="section-head">
    <h3>Externe Dienste</h3>
    <span class="eyebrow">SSO über Keycloak</span>
  </div>
  <div class="services-grid">
    <div class="handoff-card">
      <div class="handoff-icon handoff-icon-accent"><Icon name="globe" size={26} /></div>
      <div>
        <div class="handoff-title">Öffentliches Portal</div>
        <div class="handoff-sub">
          {domain} — Außenkommunikation, Sprechzeiten, Antrag-Formular. Konfiguration über
          die Portal-Verwaltung.
        </div>
      </div>
      <a class="btn" href="/portal">Portal ansehen <Icon name="external-link" size={14} /></a>
    </div>
  </div>
</div>

<style>
  .services {
    margin-top: 28px;
  }
  .section-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .section-head h3 {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 500;
    letter-spacing: -0.01em;
    color: var(--ink);
    margin: 0;
  }
  .services-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    margin-top: 10px;
  }
  .handoff-card {
    background: linear-gradient(135deg, var(--surface) 0%, var(--surface-2) 100%);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: 22px 24px;
    display: grid;
    grid-template-columns: 56px 1fr auto;
    gap: 20px;
    align-items: center;
  }
  .handoff-icon {
    width: 56px;
    height: 56px;
    border-radius: var(--r-md);
    background: var(--ink);
    color: var(--paper);
    display: grid;
    place-items: center;
  }
  .handoff-icon-accent {
    background: var(--accent);
  }
  .handoff-title {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 600;
    color: var(--ink);
  }
  .handoff-sub {
    font-size: 12.5px;
    color: var(--ink-muted);
    margin-top: 4px;
    max-width: 480px;
    line-height: 1.5;
  }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 14px;
    border-radius: var(--r-sm);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    color: var(--ink);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    text-decoration: none;
    transition: all var(--d-fast);
    line-height: 1;
  }
  .btn:hover {
    background: var(--surface-2);
  }

  @media (max-width: 860px) {
    .services-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
