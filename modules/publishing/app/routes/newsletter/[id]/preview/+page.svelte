<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData } from './$types'
  let { data }: { data: PageData } = $props()
</script>

<PageTitle title="Newsletter-Vorschau" />

<div class="p-6 max-w-3xl mx-auto">
  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
  {@html data.html}
</div>
