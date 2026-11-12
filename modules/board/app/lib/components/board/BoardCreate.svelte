<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from '$lib/components/ui/Icon.svelte'
  import { MQ_DRAWER } from '$lib/components/layout/nav-constants'

  // The "Board anlegen" control. Wide screens keep one button per body; on a phone (the shell's
  // drawer layout) several buttons would fill the screen before the board appears, so they fold
  // into ONE row: a select to choose the body and a button that creates. Choosing alone never
  // creates anything (a keyboard user arrowing through the list must not make boards; WCAG 3.2.2).
  // A single body stays one button.
  let {
    units,
    busy,
    oncreate,
    primary = false,
  }: {
    units: readonly { id: string; name: string }[]
    busy: boolean
    oncreate: (orgUnitId: string) => void
    /** The empty state's large call-to-action instead of the board bar's small button. */
    primary?: boolean
  } = $props()

  // false until mounted, so the server render and the first client render agree; a phone then
  // switches over (and follows a rotation) through the media query.
  let narrow = $state(false)
  onMount(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(MQ_DRAWER)
    const sync = () => (narrow = mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  })

  let picked = $state('')
  function create() {
    if (!picked) return
    const id = picked
    picked = ''
    oncreate(id)
  }
</script>

{#if narrow && units.length > 1}
  <div class="create-row">
    <select class="create-select" aria-label="Gremium für das neue Board" disabled={busy} bind:value={picked}>
      <option value="">Gremium wählen …</option>
      {#each units as u (u.id)}
        <option value={u.id}>{u.name}</option>
      {/each}
    </select>
    <button type="button" class="btn btn-sm" disabled={busy || !picked} onclick={create}>
      <Icon name="plus" size={13} />
      Board anlegen
    </button>
  </div>
{:else}
  {#each units as u (u.id)}
    <button class={primary ? 'btn btn-primary' : 'btn btn-sm'} disabled={busy} onclick={() => oncreate(u.id)}>
      {#if !primary}<Icon name="plus" size={13} />{/if}
      Board für {u.name} anlegen
    </button>
  {/each}
{/if}

<style>
  .create-row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .create-select {
    font: inherit;
    font-size: 13px;
    min-height: 40px;
    flex: 1 1 160px;
    min-width: 0;
    max-width: 100%;
    padding: 0 10px;
    background: var(--surface);
    color: var(--ink);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
  }
</style>
