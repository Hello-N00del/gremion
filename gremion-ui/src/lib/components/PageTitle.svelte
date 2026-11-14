<script lang="ts">
  // Sets the document <title> as "<page> – <organisation> – <product>" from the
  // tenant brand (see ./page-title.ts). The brand comes from the root layout's
  // payload (page.data.brand) with the neutral default as a fallback, so every
  // tab title follows the configured organisation and product name. Pass `title`
  // for the page; omit it on a page that has none (e.g. the login screen).
  import { page } from '$app/state'
  import { resolveBrand, type Brand } from '$lib/brand'
  import { documentTitle } from './page-title'

  let { title }: { title?: string } = $props()
  let brand = $derived(resolveBrand((page.data as { brand?: Partial<Brand> | null }).brand))
</script>

<svelte:head>
  <title>{documentTitle(title, brand)}</title>
</svelte:head>
