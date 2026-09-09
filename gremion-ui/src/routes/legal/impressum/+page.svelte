<script lang="ts">
  import type { PageData } from './$types'
  import LegalDoc from '$lib/components/legal/LegalDoc.svelte'
  let { data }: { data: PageData } = $props()
</script>

<LegalDoc
  title="Impressum"
  sub="Angaben gemäß § 5 DDG (Digitale-Dienste-Gesetz)"
  html={data.html}
  active="impressum"
/>
