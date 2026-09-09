<script lang="ts">
  import Icon from '$lib/components/ui/Icon.svelte'
  import type { InstanceStateMeta } from '$lib/instance-status'

  // #264: instance not fully converged → banner linking to Systemstatus.
  // The parent gates rendering on showConvBanner; this component only owns
  // the markup + styling of the banner itself.
  let { instanceMeta }: { instanceMeta: InstanceStateMeta } = $props()
</script>

<a
  class="conv-banner"
  class:danger={instanceMeta.tone === 'danger'}
  href="/systemstatus"
>
  <Icon name={instanceMeta.icon} size={18} />
  <div class="conv-banner-body">
    <div class="conv-banner-title">{instanceMeta.headline}</div>
    <div class="conv-banner-sub">{instanceMeta.sub}</div>
  </div>
  <span class="conv-banner-cta">Systemstatus <Icon name="chevron-right" size={15} /></span>
</a>

<style>
  /* #264 convergence banner — warn tone by default, danger for a failed instance.
     An <a> to /systemstatus; resets link defaults. */
  .conv-banner {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 18px;
    margin-bottom: 20px;
    border: 1px solid var(--border);
    border-left: 3px solid var(--ember);
    border-radius: var(--r-md);
    background: var(--ember-soft);
    color: var(--ink);
    text-decoration: none;
    transition: background var(--d-fast);
  }
  .conv-banner:hover {
    background: var(--surface-2);
  }
  .conv-banner.danger {
    border-left-color: var(--rust);
    background: var(--rust-soft);
  }
  .conv-banner :global(svg) {
    flex-shrink: 0;
    color: var(--ember-ink);
  }
  .conv-banner.danger :global(svg) {
    color: var(--rust-ink);
  }
  .conv-banner-body {
    flex: 1;
    min-width: 0;
  }
  .conv-banner-title {
    font-family: var(--font-display);
    font-size: 14px;
    font-weight: 600;
    color: var(--ink);
  }
  .conv-banner-sub {
    font-size: 12px;
    color: var(--ink-2);
    margin-top: 2px;
    line-height: 1.45;
  }
  .conv-banner-cta {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: 600;
    color: var(--ink-2);
  }
</style>
