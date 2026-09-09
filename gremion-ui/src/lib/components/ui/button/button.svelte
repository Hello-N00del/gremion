<script lang="ts">
  import { cn } from '$lib/utils'
  import type { HTMLButtonAttributes, HTMLAnchorAttributes } from 'svelte/elements'

  type Variant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'
  type Size = 'default' | 'sm' | 'lg' | 'icon'

  interface ButtonProps extends HTMLButtonAttributes {
    variant?: Variant
    size?: Size
    class?: string
    href?: never
  }

  interface AnchorProps extends HTMLAnchorAttributes {
    variant?: Variant
    size?: Size
    class?: string
    href: string
  }

  type Props = ButtonProps | AnchorProps

  const variantClasses: Record<Variant, string> = {
    // Design-review 2026-07 B1: primary is NEUTRAL ink-on-paper (~16:1) per
    // gremion-components.css `.btn-primary` (#287: accent = selected/active/
    // instance, not "primary action"); destructive per `.btn-danger` (rust +
    // white). The old accent-fill + accent-ink text was ~1.24:1.
    // #343 R6: the dark-mode failure was the REST state (white on a 70%-L rust
    // fill ≈ 2.4:1), so text-on-fill is `--on-rust` (inverts to ink in dark) and
    // hover moves to a dedicated `--rust-hover` fill. `--rust-ink` is a
    // text-on-soft token and must never be used as a fill.
    default: 'bg-ink text-paper hover:bg-ink-2',
    destructive: 'bg-rust text-on-rust hover:bg-rust-hover',
    outline: 'border border-border bg-paper hover:bg-surface-3 hover:text-ink',
    secondary: 'bg-surface-2 text-ink hover:bg-surface-2/80',
    ghost: 'hover:bg-surface-3 hover:text-ink',
    link: 'text-accent underline-offset-4 hover:underline'
  }

  const sizeClasses: Record<Size, string> = {
    default: 'h-10 px-4 py-2',
    sm: 'h-9 rounded-md px-3',
    lg: 'h-11 rounded-md px-8',
    icon: 'h-10 w-10'
  }

  let {
    variant = 'default',
    size = 'default',
    class: className = '',
    href,
    children,
    ...restProps
  }: Props = $props()

  const base = $derived(cn(
    'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-paper transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
    variantClasses[variant],
    sizeClasses[size],
    className
  ))
</script>

{#if href}
  <a {href} class={base} {...(restProps as HTMLAnchorAttributes)}>
    {@render children?.()}
  </a>
{:else}
  <button class={base} {...(restProps as HTMLButtonAttributes)}>
    {@render children?.()}
  </button>
{/if}
