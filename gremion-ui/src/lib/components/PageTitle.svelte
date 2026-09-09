<script lang="ts">
  // Sets the document <title> as "<segment> – <product>" from the tenant brand
  // (v4 re-audit slice 10). `product` comes from the root layout's brand payload
  // (page.data.brand) with the canonical default as a fallback, so every tab
  // title follows the configured product name. Pass `title` for the page segment;
  // omit it for the bare product (e.g. the login screen).
  import { page } from '$app/state'
  import { resolveBrand, type Brand } from '$lib/brand'

  let { title }: { title?: string } = $props()
  let product = $derived(
    resolveBrand((page.data as { brand?: Partial<Brand> | null }).brand).product
  )
</script>

<svelte:head>
  <title>{title ? `${title} – ${product}` : product}</title>
</svelte:head>
