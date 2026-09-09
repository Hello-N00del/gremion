<script lang="ts">
  import { cn } from '$lib/utils'
  import type { HTMLSelectAttributes } from 'svelte/elements'

  interface Props extends Omit<HTMLSelectAttributes, 'value'> {
    value?: string | number | readonly string[] | undefined
    class?: string
  }

  let { class: className = '', value = $bindable(), children, ...restProps }: Props = $props()
</script>

<select
  bind:value
  class={cn(
    'flex h-10 w-full items-center justify-between rounded-md border border-border bg-paper px-3 py-2 text-sm ring-offset-paper placeholder:text-ink-muted focus:outline-hidden focus:ring-2 focus:ring-accent focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
    className
  )}
  {...restProps}
>
  {@render children?.()}
</select>
