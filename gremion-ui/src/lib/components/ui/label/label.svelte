<script lang="ts">
  import { cn } from '$lib/utils'
  import type { HTMLLabelAttributes } from 'svelte/elements'

  interface Props extends HTMLLabelAttributes {
    class?: string
  }

  let { class: className = '', children, ...restProps }: Props = $props()
</script>

<label
  class={cn(
    'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
    className
  )}
  {...restProps}
>
  {@render children?.()}
</label>
