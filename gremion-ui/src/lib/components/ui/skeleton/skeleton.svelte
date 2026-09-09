<script lang="ts">
  import { cn } from '$lib/utils'

  interface Props {
    class?: string
  }

  let { class: className = '' }: Props = $props()
</script>

<div class={cn('animate-pulse rounded-md bg-surface-2', className)}></div>
