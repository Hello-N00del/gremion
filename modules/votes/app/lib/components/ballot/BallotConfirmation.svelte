<script lang="ts">
  interface Props { auditUrl: string }
  let { auditUrl }: Props = $props()
</script>

<div class="rounded-lg border border-border bg-surface p-8 text-center space-y-4">
  <div class="text-4xl" aria-hidden="true">✓</div>
  <h2 class="text-lg font-semibold">Stimme abgegeben</h2>
  <p class="text-sm text-ink-muted">
    Deine Stimme wurde verschlüsselt und übermittelt. Sie ist durch ElGamal-Verschlüsselung gesichert
    und kann nicht mit deiner Identität verknüpft werden.
  </p>
  {#if auditUrl}
    <a href={auditUrl} target="_blank" rel="noopener noreferrer" class="inline-block text-sm text-accent hover:underline">
      Stimmzettel kryptografisch prüfen ↗
    </a>
  {/if}
</div>
