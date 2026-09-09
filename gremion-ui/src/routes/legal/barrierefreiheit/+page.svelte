<script lang="ts">
  import type { PageData } from './$types'
  import LegalDoc from '$lib/components/legal/LegalDoc.svelte'
  let { data }: { data: PageData } = $props()
</script>

<LegalDoc
  title="Barrierefreiheitserklärung"
  sub="Erklärung gemäß § 12b BGG / BITV 2.0 (EU-Richtlinie 2016/2102)"
  html={data.html}
  active="barrierefreiheit"
/>
