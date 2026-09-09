<script lang="ts">
  import { cn } from '$lib/utils'
  import type { HTMLInputAttributes } from 'svelte/elements'

  interface Props extends Omit<HTMLInputAttributes, 'value'> {
    value?: string | number | readonly string[] | undefined
    class?: string
  }

  let { class: className = '', value = $bindable(), ...restProps }: Props = $props()
</script>

<input
  bind:value
  class={cn(
    'flex h-10 w-full rounded-md border border-border bg-paper px-3 py-2 text-sm ring-offset-paper file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
    className
  )}
  {...restProps}
/>
