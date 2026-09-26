<script lang="ts">
  // The signed-in user's initials, name and friendly role labels (never raw
  // realm-role keys or Keycloak group ids — WP-2 identity-leakage fix).
  import Icon from '$lib/components/ui/Icon.svelte'
  import { roleLabels } from '$lib/auth/labels'

  let { userName = '', roles = [] }: { userName?: string; roles?: string[] } = $props()

  function initials(name: string): string {
    if (!name) return '?'
    return name
      .split(' ')
      .map((w) => w[0] ?? '')
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase()
  }
  let labels = $derived(roleLabels(roles))
</script>

<div class="sb-foot">
  <div class="avatar" aria-hidden="true">{initials(userName)}</div>
  <div class="who nav-expanded-only">
    <div class="n">{userName || '—'}</div>
    {#if labels.length > 0}
      <div class="r">
        {#each labels.slice(0, 2) as label (label)}
          <span class="role-pill"><Icon name="shield" size={9} /> {label}</span>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .sb-foot {
    border-top: 1px solid var(--border);
    padding: 10px 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
  }
  .avatar {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--surface);
    display: grid;
    place-items: center;
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 12px;
    flex-shrink: 0;
  }
  .who {
    flex: 1;
    min-width: 0;
  }
  .n {
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }
  .r {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--ink-muted);
    letter-spacing: 0.06em;
    margin-top: 3px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
  }
  .role-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: var(--surface-2);
    padding: 2px 8px;
    border-radius: 99px;
  }
</style>
