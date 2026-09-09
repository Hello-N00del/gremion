<script lang="ts">
  import Icon from '$lib/components/ui/Icon.svelte'
  import { colorblind, themeMode, fontSize, reducedMotion, type ColorblindType } from '$lib/stores/theme'
  import { t, lang } from '$lib/i18n'

  const MODES: { key: ColorblindType; label: string; desc: string }[] = [
    { key: 'none', label: 'Keine Korrektur',    desc: 'Standard-Palette, keine Anpassung' },
    { key: 'rg',   label: 'Rot-Grün-Schwäche',  desc: 'Deuteranopie / Protanopie — betrifft ca. 8 % der Männer' },
    { key: 'by',   label: 'Blau-Gelb-Schwäche', desc: 'Tritanopie — sehr selten' },
  ]

  const FONT_SIZES: { key: string; label: string }[] = [
    { key: 'normal', label: 'Normal'    },
    { key: 'large',  label: 'Groß'      },
    { key: 'xlarge', label: 'Sehr groß' },
  ]
</script>

<div class="py-4 space-y-8">

  <!-- Language (moved out of TabGeneral, #168) -->
  <section>
    <h3 class="text-sm font-semibold mb-1" style="font-family: var(--font-display);">{$t('settings.appearance.language')}</h3>
    <p class="text-xs text-ink-muted mb-4">{$t('settings.appearance.language.sub')}</p>
    <div class="flex gap-2" role="group" aria-labelledby="lang-select">
      <button
        type="button"
        id="lang-select"
        aria-pressed={$lang === 'de'}
        onclick={() => lang.set('de')}
        class="flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors
               {$lang === 'de'
                 ? 'border-accent bg-accent/10 text-accent'
                 : 'border-border text-ink-muted hover:border-accent/50 hover:text-ink'}"
      >
        <span class="text-base" aria-hidden="true">🇩🇪</span>
        {$t('settings.appearance.lang.de')}
      </button>
      <button
        type="button"
        aria-pressed={$lang === 'en'}
        onclick={() => lang.set('en')}
        class="flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors
               {$lang === 'en'
                 ? 'border-accent bg-accent/10 text-accent'
                 : 'border-border text-ink-muted hover:border-accent/50 hover:text-ink'}"
      >
        <span class="text-base" aria-hidden="true">🇬🇧</span>
        {$t('settings.appearance.lang.en')}
      </button>
    </div>
  </section>

  <!-- Color vision -->
  <section>
    <h3 class="text-sm font-semibold mb-1" style="font-family: var(--font-display);">Farbsehkorrektur</h3>
    <p class="text-xs text-ink-muted mb-4">
      Passt die Farbpalette der Oberfläche an deine Sehbedingungen an.
      Die Einstellung wird lokal gespeichert und nur auf deinem Gerät angewendet.
    </p>

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
      <div class="text-[10px] font-mono uppercase tracking-wider text-ink-muted mb-2">Vorschau</div>
      <div class="flex gap-2">
        {#each [
          ['Akzent', 'var(--ds-accent)'],
          ['Bernstein', 'var(--ember)'],
          ['Grün', 'var(--pine)'],
          ['Rot', 'var(--rust)'],
          ['Dunkel', '#161513'],
        ] as [label, color]}
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
    <h3 class="text-sm font-semibold mb-1" style="font-family: var(--font-display);">Erscheinungsbild</h3>
    <p class="text-xs text-ink-muted mb-4">Wähle zwischen hellem und dunklem Modus.</p>
    <div class="flex gap-2">
      {#each [
        { key: 'light', label: 'Hell',   icon: 'sun'  },
        { key: 'dark',  label: 'Dunkel', icon: 'moon' },
      ] as theme}
        <button
          type="button"
          onclick={() => themeMode.set(theme.key as 'light' | 'dark')}
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
    <h3 class="text-sm font-semibold mb-1" style="font-family: var(--font-display);">Schriftgröße</h3>
    <p class="text-xs text-ink-muted mb-4">Ändert die Basisgröße der Benutzeroberfläche.</p>
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
    <h3 class="text-sm font-semibold mb-1" style="font-family: var(--font-display);">Animationen</h3>
    <p class="text-xs text-ink-muted mb-3">Reduziere Bewegungseffekte, wenn du empfindlich auf Animationen reagierst.</p>
    <label class="flex items-center gap-3 cursor-pointer">
      <input
        type="checkbox"
        class="rounded border-border"
        checked={$reducedMotion}
        onchange={(e) => reducedMotion.set((e.target as HTMLInputElement).checked)}
      />
      <div>
        <div class="text-sm">Animationen reduzieren</div>
        <div class="text-xs text-ink-muted">Deaktiviert Übergänge und Bewegungseffekte in der Oberfläche</div>
      </div>
    </label>
  </section>

</div>
