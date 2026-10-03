<script lang="ts">
  import { callStore } from '$lib/stores/call-store.svelte'
</script>

<!-- The live-call indicator of the TopBar's `liveCall` slot part (TASK-205b). Shown only while a call is
     running; TopBar keeps this part below 768 px (its wrapper caps the width so a long label cannot push
     the bar wide). -->
{#if callStore.status !== 'idle'}
  <span class="call-live" title="Aktiver Element Call · LiveKit">
    <span class="pulse" aria-hidden="true"></span> CALL · LIVE
  </span>
{/if}

<style>
  .call-live {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 9px;
    border-radius: 100px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-weight: 500;
    background: var(--pine-soft);
    color: var(--pine);
    border: 1px solid transparent;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .pulse {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--pine);
    box-shadow: 0 0 0 2px var(--pine-soft);
  }
</style>
