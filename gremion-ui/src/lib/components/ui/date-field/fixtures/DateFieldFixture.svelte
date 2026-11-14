<script lang="ts">
  // Test harness: binds the field and shows the bound value, so a test can read
  // what a form using the field would hold.
  import { untrack } from 'svelte'
  import DateTimeFieldDe from '../date-time-field-de.svelte'

  let { initial = '', dateOnly = true }: { initial?: string; dateOnly?: boolean } = $props()
  let value = $state(untrack(() => initial))
</script>

<label for="field">Stichtag</label>
<DateTimeFieldDe id="field" label="Stichtag" {dateOnly} bind:value />
<span data-testid="bound">{value}</span>
<button type="button" onclick={() => (value = '2031-12-24')}>von außen setzen</button>
