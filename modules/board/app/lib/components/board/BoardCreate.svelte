<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from '$lib/components/ui/Icon.svelte'
  import { MQ_DRAWER } from '$lib/components/layout/nav-constants'

  // The "Board anlegen" control. Wide screens keep one button per body; on a phone (the shell's
  // drawer layout) several buttons would fill the screen before the board appears, so they fold
  // into ONE select. A single body stays one button: still a single control.
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

  // The select is an action menu, not a field: it springs back to its title after every pick.
  function onPick(e: Event & { currentTarget: HTMLSelectElement }) {
    const id = e.currentTarget.value
    e.currentTarget.value = ''
    if (id) oncreate(id)
  }
</script>

{#if narrow && units.length > 1}
  <select class="create-select" aria-label="Board anlegen" disabled={busy} onchange={onPick}>
    <option value="">Board anlegen …</option>
    {#each units as u (u.id)}
      <option value={u.id}>Board für {u.name}</option>
    {/each}
  </select>
{:else}
  {#each units as u (u.id)}
    <button class={primary ? 'btn btn-primary' : 'btn btn-sm'} disabled={busy} onclick={() => oncreate(u.id)}>
      {#if !primary}<Icon name="plus" size={13} />{/if}
      Board für {u.name} anlegen
    </button>
  {/each}
{/if}

<style>
  .create-select {
    font: inherit;
    font-size: 13px;
    min-height: 40px;
    max-width: 100%;
    padding: 0 10px;
    background: var(--surface);
    color: var(--ink);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
  }
</style>
