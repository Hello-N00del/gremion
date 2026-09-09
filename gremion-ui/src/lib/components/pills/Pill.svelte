<script lang="ts">
  // Canonical state pill. Implements the pill-icon contract (app.css §16
  // finding 2 / DRIFT.md): every *state* tone (warn/danger/success/info) MUST
  // render an icon alongside its text, so warn (ember) and danger (rust) stay
  // distinguishable in the cb-by colourblind mode where those hues sit close.
  // Consumes the shared `.pill`/`.pill-*` classes from app.css (real tokens).
  import Icon from '$lib/components/ui/Icon.svelte'
  import type { Snippet } from 'svelte'

  type Tone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger'

  let {
    tone = 'neutral',
    icon,
    tiny = false,
    title,
    children,
  }: {
    tone?: Tone
    /** Override the default glyph; `null` suppresses it on a non-state tone. */
    icon?: string | null
    tiny?: boolean
    title?: string
    children?: Snippet
  } = $props()

  // Default disambiguating glyph per state tone. Neutral/accent carry no glyph
  // unless one is passed explicitly (e.g. the board's "Sitzung" source chip).
  const STATE_ICON: Record<Tone, string | null> = {
    neutral: null,
    accent: null,
    success: 'check',
    warn: 'clock',
    danger: 'alert-triangle',
  }
  const glyph = $derived(icon === undefined ? STATE_ICON[tone] : icon)
</script>

<span
  class="pill"
  class:pill-tiny={tiny}
  class:pill-accent={tone === 'accent'}
  class:pill-success={tone === 'success'}
  class:pill-warn={tone === 'warn'}
  class:pill-danger={tone === 'danger'}
  {title}
>
  {#if glyph}<Icon name={glyph} size={tiny ? 10 : 12} aria-hidden="true" />{/if}
  {@render children?.()}
</span>
