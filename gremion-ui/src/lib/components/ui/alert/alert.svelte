<script lang="ts">
  import { cn } from '$lib/utils'

  type Variant = 'default' | 'destructive'

  interface Props {
    variant?: Variant
    class?: string
    children?: import('svelte').Snippet
  }

  const variantClasses: Record<Variant, string> = {
    default: 'bg-paper text-ink',
    destructive: 'border-rust/50 text-rust dark:border-rust [&>svg]:text-rust'
  }

  let { variant = 'default', class: className = '', children }: Props = $props()
</script>

<div
  role="alert"
  class={cn(
    'relative w-full rounded-lg border p-4 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg~*]:pl-7',
    variantClasses[variant],
    className
  )}
>
  {@render children?.()}
</div>
