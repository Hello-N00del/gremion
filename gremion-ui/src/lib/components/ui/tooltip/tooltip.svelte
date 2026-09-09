<script lang="ts">
  import { cn } from '$lib/utils'
  import type { HTMLAttributes } from 'svelte/elements'

  interface Props extends HTMLAttributes<HTMLDivElement> {
    content: string
    class?: string
  }

  let {
    content,
    class: className = '',
    children,
    ...restProps
  }: Props = $props()
</script>

<div class={cn('relative inline-block group', className)} {...restProps}>
  {@render children?.()}
  <div
    class="absolute z-50 hidden group-hover:block px-3 py-1.5 text-xs rounded-md bg-ink text-paper border shadow-md -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap"
  >
    {content}
  </div>
</div>
