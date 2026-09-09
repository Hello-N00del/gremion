<script lang="ts">
  import type { PageData } from './$types'
  import LegalDoc from '$lib/components/legal/LegalDoc.svelte'
  let { data }: { data: PageData } = $props()
</script>

<LegalDoc
  title="Datenschutzerklärung"
  sub="Informationen nach Art. 13/14 DSGVO"
  html={data.html}
  active="datenschutz"
/>
