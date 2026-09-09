<script lang="ts">
  import Icon from '$lib/components/ui/Icon.svelte'

  // Unplaced guest (Task 3.3, screen 27): invited, not yet assigned to a
  // Gremium. The parent gates rendering on `unplaced`; this component only
  // owns the empty-state markup + styling.
  let { gremiumSingular, councilAdmin }: { gremiumSingular: string; councilAdmin: string } =
    $props()
</script>

<div class="card empty-state unplaced-card">
  <div class="glyph"><Icon name="users" size={22} /></div>
  <div class="ttl">Eingeladen, noch nicht zugeordnet</div>
  <div class="sub">
    Ihr Zugang ist aktiv, aber Sie sind noch keinem {gremiumSingular} oder Referat zugeordnet.
    Sobald ein:e {councilAdmin} Sie einem {gremiumSingular} hinzufügt, erscheinen hier Ihre
    Termine, Abstimmungen und Anträge.
  </div>
  <div class="unplaced-actions">
    <a class="btn btn-sm" href="/settings"><Icon name="settings" size={14} /> Profil &amp; Konto</a>
  </div>
</div>

<style>
  /* .card + .empty-state come from app.css; the local .card override below
     (overflow: hidden) still applies here — this block adds only the action
     row + spacing plus the button styling the action link needs. */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: var(--sh-1);
    overflow: hidden;
  }
  .unplaced-card {
    margin-top: 8px;
  }
  .unplaced-actions {
    display: flex;
    gap: 8px;
    justify-content: center;
    flex-wrap: wrap;
    margin-top: 18px;
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
  .btn-sm {
    padding: 5px 10px;
    font-size: 12px;
  }
</style>
