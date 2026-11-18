<script lang="ts">
  import Icon from '$lib/components/ui/Icon.svelte'
  import { colorblind, themeMode, fontSize, reducedMotion, type ColorblindType } from '$lib/stores/theme'
  import { t, lang } from '$lib/i18n'
  // KIT-2 rule (R25-3): $app/state, not the deprecated $app/stores.
  import { page } from '$app/state'

  const MODES: { key: ColorblindType; label: string; desc: string }[] = $derived([
    { key: 'none', label: $t('settings.appearance.cb.none.label'), desc: $t('settings.appearance.cb.none.desc') },
    { key: 'rg',   label: $t('settings.appearance.cb.rg.label'),   desc: $t('settings.appearance.cb.rg.desc') },
    { key: 'by',   label: $t('settings.appearance.cb.by.label'),   desc: $t('settings.appearance.cb.by.desc') },
  ])

  const FONT_SIZES: { key: string; label: string }[] = $derived([
    { key: 'normal', label: $t('settings.appearance.font.normal') },
    { key: 'large',  label: $t('settings.appearance.font.large') },
    { key: 'xlarge', label: $t('settings.appearance.font.xlarge') },
  ])

  const SWATCHES: [string, string][] = $derived([
    [$t('settings.appearance.swatch.accent'), 'var(--ds-accent)'],
    [$t('settings.appearance.swatch.amber'), 'var(--ember)'],
    [$t('settings.appearance.swatch.green'), 'var(--pine)'],
    [$t('settings.appearance.swatch.red'), 'var(--rust)'],
    [$t('settings.appearance.swatch.dark'), '#161513'],
  ])

  const THEMES: { key: 'light' | 'dark'; label: string; icon: string }[] = $derived([
    { key: 'light', label: $t('settings.appearance.theme.light'), icon: 'sun' },
    { key: 'dark',  label: $t('settings.appearance.theme.dark'),  icon: 'moon' },
  ])
</script>

<div class="py-4 space-y-8" lang={$lang}>

  <!-- Language (moved out of TabGeneral, #168) -->
  <section>
    <h3 id="lang-heading" class="text-sm font-semibold mb-1" style="font-family: var(--font-display);">{$t('settings.appearance.language')}</h3>
    <p class="text-xs text-ink-muted mb-4">{$t('settings.appearance.language.sub')}</p>
    <!-- TASK-062: a plain form POST + 303 (routes/settings/+page.server.ts,
         action `locale`). Works with JS off; the next document is rendered
         in the new language by the server, so nothing flips after hydration. -->
    <form method="POST" action="/settings?/locale" class="flex gap-2" role="group" aria-labelledby="lang-heading">
      <input type="hidden" name="redirectTo" value={page.url.pathname} />
      <button
        type="submit"
        name="locale"
        value="de"
        lang="de"
        aria-pressed={$lang === 'de'}
        class="flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors
               {$lang === 'de'
                 ? 'border-accent bg-accent/10 text-accent'
                 : 'border-border text-ink-muted hover:border-accent/50 hover:text-ink'}"
      >
        <span class="text-base" aria-hidden="true">🇩🇪</span>
        {$t('settings.appearance.lang.de')}
      </button>
      <button
        type="submit"
        name="locale"
        value="en"
        lang="en"
        aria-pressed={$lang === 'en'}
        class="flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors
               {$lang === 'en'
                 ? 'border-accent bg-accent/10 text-accent'
                 : 'border-border text-ink-muted hover:border-accent/50 hover:text-ink'}"
      >
        <span class="text-base" aria-hidden="true">🇬🇧</span>
        {$t('settings.appearance.lang.en')}
      </button>
    </form>
    {#if page.form?.localeError === 'not-saved'}
      <p role="alert" class="mt-3 text-xs text-rust-ink">{$t('settings.appearance.language.notSaved')}</p>
    {:else if page.form?.localeError === 'invalid'}
      <p role="alert" class="mt-3 text-xs text-rust-ink">{$t('settings.appearance.language.invalid')}</p>
    {/if}
  </section>

  <!-- Color vision -->
  <section>
    <h3 class="text-sm font-semibold mb-1" style="font-family: var(--font-display);">{$t('settings.appearance.cb.heading')}</h3>
    <p class="text-xs text-ink-muted mb-4">{$t('settings.appearance.cb.help')}</p>

    <div class="space-y-2">
      {#each MODES as mode}
        <label class="flex items-start gap-4 p-3 rounded-lg border border-border cursor-pointer hover:bg-surface-2/50 transition-colors" class:border-accent={$colorblind === mode.key}>
          <input
            type="radio"
            name="colorblind-mode"
            value={mode.key}
            checked={$colorblind === mode.key}
            onchange={() => colorblind.set(mode.key)}
            class="mt-0.5"
          />
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium">{mode.label}</div>
            <div class="text-xs text-ink-muted">{mode.desc}</div>
          </div>
          {#if $colorblind === mode.key}
            <Icon name="check" size={14} class="text-accent shrink-0 mt-0.5" />
          {/if}
        </label>
      {/each}
    </div>

    <!-- Palette preview -->
    <div class="mt-4 p-3 rounded-lg border border-border bg-surface-2/40">
      <div class="text-[10px] font-mono uppercase tracking-wider text-ink-muted mb-2">{$t('settings.appearance.preview')}</div>
      <div class="flex gap-2">
        {#each SWATCHES as [label, color]}
          <div class="flex-1 text-center">
            <div class="h-6 rounded-md" style="background: {color};"></div>
            <div class="text-[9px] font-mono text-ink-muted mt-1">{label}</div>
          </div>
        {/each}
      </div>
    </div>
  </section>

  <!-- Theme -->
  <section>
    <h3 class="text-sm font-semibold mb-1" style="font-family: var(--font-display);">{$t('settings.appearance.theme.heading')}</h3>
    <p class="text-xs text-ink-muted mb-4">{$t('settings.appearance.theme.help')}</p>
    <div class="flex gap-2">
      {#each THEMES as theme}
        <button
          type="button"
          onclick={() => themeMode.set(theme.key)}
          class="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border transition-colors text-sm"
          style={$themeMode === theme.key
            ? 'border-color: var(--ds-accent); background: oklch(95% 0.03 252); color: oklch(35% 0.12 252);'
            : 'border-color: var(--border); background: transparent; color: var(--ink-muted);'}
        >
          <Icon name={theme.icon} size={15} />
          {theme.label}
        </button>
      {/each}
    </div>
  </section>

  <!-- Font size -->
  <section>
    <h3 class="text-sm font-semibold mb-1" style="font-family: var(--font-display);">{$t('settings.appearance.font.heading')}</h3>
    <p class="text-xs text-ink-muted mb-4">{$t('settings.appearance.font.help')}</p>
    <div class="flex gap-2">
      {#each FONT_SIZES as f}
        <button
          type="button"
          onclick={() => fontSize.set(f.key)}
          class="flex-1 py-2 rounded-lg border text-sm transition-colors"
          style={$fontSize === f.key
            ? 'border-color: var(--ds-accent); background: oklch(95% 0.03 252); color: oklch(35% 0.12 252);'
            : 'border-color: var(--border); background: transparent; color: var(--ink-muted);'}
        >
          {f.label}
        </button>
      {/each}
    </div>
  </section>

  <!-- Motion -->
  <section>
    <h3 class="text-sm font-semibold mb-1" style="font-family: var(--font-display);">{$t('settings.appearance.motion.heading')}</h3>
    <p class="text-xs text-ink-muted mb-3">{$t('settings.appearance.motion.help')}</p>
    <label class="flex items-center gap-3 cursor-pointer">
      <input
        type="checkbox"
        aria-label={$t('settings.appearance.motion.label')}
        class="rounded border-border"
        checked={$reducedMotion}
        onchange={(e) => reducedMotion.set((e.target as HTMLInputElement).checked)}
      />
      <div>
        <div class="text-sm">{$t('settings.appearance.motion.label')}</div>
        <div class="text-xs text-ink-muted">{$t('settings.appearance.motion.desc')}</div>
      </div>
    </label>
  </section>

</div>
