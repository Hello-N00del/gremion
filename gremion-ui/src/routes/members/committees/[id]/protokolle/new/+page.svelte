<script lang="ts">
  import type { PageData, ActionData } from './$types'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'

  let { data, form }: { data: PageData; form: ActionData } = $props()
</script>

<div class="max-w-lg space-y-6">
  <h2 class="text-xl font-semibold">Neues Protokoll</h2>

  {#if form?.error}
    <p class="text-sm text-rust">{form.error}</p>
  {/if}

  <form method="POST" class="space-y-4">
    <div class="space-y-1">
      <Label for="title">Titel</Label>
      <Input id="title" name="title" placeholder="z.B. Vollversammlung April 2026" required />
    </div>
    <div class="space-y-1">
      <Label for="meetingDate">Sitzungsdatum</Label>
      <Input id="meetingDate" name="meetingDate" type="date" required />
    </div>
    <div class="space-y-1">
      <Label for="location">Ort (optional)</Label>
      <Input id="location" name="location" placeholder="z.B. Raum A204" />
    </div>
    <div class="flex gap-2">
      <Button type="submit">Protokoll anlegen</Button>
      <Button variant="ghost" href="../protokolle">Abbrechen</Button>
    </div>
  </form>
</div>
