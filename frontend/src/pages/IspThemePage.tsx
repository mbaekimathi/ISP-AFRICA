import { Check, Moon, Sun } from "lucide-react";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { PageHeader } from "@/components/ui/DetailGrid";
import { FormPicker } from "@/components/ui/FormField";
import { usePageMeta } from "@/hooks/usePageMeta";
import { cn } from "@/lib/cn";
import { THEME_PRESETS, type Theme, type ThemePreset } from "@/lib/theme";
import { useTheme } from "@/providers/ThemeProvider";

const MODE_OPTIONS: { id: Theme; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

function ModeIcon({ mode }: { mode: Theme }) {
  return mode === "dark" ? (
    <Moon className="h-3.5 w-3.5" aria-hidden="true" />
  ) : (
    <Sun className="h-3.5 w-3.5" aria-hidden="true" />
  );
}

function presetLabel(id: ThemePreset["id"]): string {
  return THEME_PRESETS.find((preset) => preset.id === id)?.label ?? id;
}

/* Mini preview: the `theme-<id>` (and `dark`) classes are scoped to this box,
   so every token class inside resolves that preset's full palette — page
   background, sidebar, surfaces, and brand accents — without changing the
   rest of the page. */
function ThemePresetPreview({ preset, mode }: { preset: ThemePreset; mode: Theme }) {
  return (
    <div
      className={cn(`theme-${preset.id}`, mode === "dark" && "dark", "overflow-hidden rounded-lg border border-border")}
      aria-hidden="true"
    >
      <div className="flex h-20 bg-background">
        <span className="w-7 shrink-0 bg-sidebar" />
        <span className="grid min-w-0 flex-1 gap-1.5 p-2">
          <span className="h-2.5 rounded-sm bg-surface shadow-xs" />
          <span className="flex min-h-0 flex-1 gap-1.5">
            <span className="flex-1 rounded-sm bg-surface shadow-xs" />
            <span className="flex-1 rounded-sm bg-surface-muted" />
          </span>
          <span className="flex items-center gap-1">
            <span className="h-3 w-7 rounded-sm bg-primary" />
            <span className="h-3 w-7 rounded-sm bg-accent" />
          </span>
        </span>
      </div>
    </div>
  );
}

function ThemePresetCard({
  preset,
  mode,
  selected,
  onSelect,
}: {
  preset: ThemePreset;
  mode: Theme;
  selected: boolean;
  onSelect: (id: ThemePreset["id"]) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={cn(
        "grid gap-3 rounded-xl border bg-surface p-4 text-left shadow-xs transition duration-fast ease-out",
        selected ? "border-primary ring-2 ring-primary/30" : "border-border hover:bg-surface-muted",
      )}
      onClick={() => onSelect(preset.id)}
    >
      <ThemePresetPreview preset={preset} mode={mode} />
      <span className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-foreground">{preset.label}</span>
        {selected ? <Check className="h-4 w-4 text-primary" aria-hidden="true" /> : null}
      </span>
      <span className="text-sm leading-6 text-muted-foreground">{preset.description}</span>
    </button>
  );
}

/* Live preview: unscoped, so it always reflects the active mode + preset. */
function ThemeLivePreview() {
  return (
    <div className="overflow-hidden rounded-xl border border-border" aria-hidden="true">
      <div className="h-1.5 bg-gradient-brand" />
      <div className="flex h-16 bg-background">
        <span className="w-10 shrink-0 bg-sidebar" />
        <span className="grid min-w-0 flex-1 grid-cols-3 items-center gap-2 p-2.5">
          <span className="h-7 rounded-md bg-surface shadow-xs" />
          <span className="h-7 rounded-md bg-surface-raised shadow-xs" />
          <span className="h-7 rounded-md bg-surface-muted" />
        </span>
      </div>
      <div className="grid gap-4 border-t border-border bg-surface p-5">
        <div className="grid gap-1">
          <span className="text-sm font-semibold text-foreground">Sample panel</span>
          <span className="text-sm text-muted-foreground">
            Buttons, badges, and meters using the current theme tokens.
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex min-h-9 items-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm">
            Primary
          </span>
          <span className="inline-flex min-h-9 items-center rounded-lg border border-border bg-surface px-4 text-sm font-semibold text-foreground shadow-xs">
            Secondary
          </span>
          <span className="inline-flex min-h-9 items-center rounded-lg px-3 text-sm font-semibold text-primary">
            Link
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-caption font-semibold">
          <span className="rounded-full bg-success-soft px-2.5 py-1 text-success">Paid</span>
          <span className="rounded-full bg-warning-soft px-2.5 py-1 text-warning">Pending</span>
          <span className="rounded-full bg-destructive-soft px-2.5 py-1 text-destructive">Overdue</span>
          <span className="rounded-full bg-info-soft px-2.5 py-1 text-info">Queued</span>
        </div>
        <div className="grid gap-1.5">
          <span className="text-caption font-medium text-muted-foreground">Usage this month</span>
          <span className="live-meter">
            <span style={{ "--meter": "68%" } as React.CSSProperties} />
          </span>
        </div>
      </div>
    </div>
  );
}

export function IspThemePage() {
  const { theme, setTheme, themeName, savedThemeName, setThemeName, previewThemeName, resetThemeName } =
    useTheme();
  usePageMeta("THEME — ISP CENTRIC", "Choose the colour theme and appearance for ISP CENTRIC.");

  const dirty = themeName !== savedThemeName;

  return (
    <div className="page-shell py-8">
      <PageHeader
        title="Theme"
        description="Choose the colour theme and appearance shown on this device."
      />
      <div className="mt-6 grid max-w-2xl gap-8">
        <section className="card grid gap-4 p-5" aria-label="Appearance">
          <div className="flex items-center gap-2">
            <ModeIcon mode={theme} />
            <h2 className="text-sm font-semibold text-foreground">Appearance</h2>
          </div>
          <FormPicker
            label="Appearance mode"
            options={MODE_OPTIONS}
            value={theme}
            onChange={(id) => setTheme(id as Theme)}
          />
        </section>
        <section className="grid gap-4" aria-label="Colour theme">
          <div className="grid gap-1">
            <h2 className="text-sm font-semibold text-foreground">Colour theme</h2>
            <p className="text-caption leading-5 text-muted-foreground">
              Pick a theme to preview it across the portal right away — nothing is saved until you
              choose Save.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Colour theme">
            {THEME_PRESETS.map((preset) => (
              <ThemePresetCard
                key={preset.id}
                preset={preset}
                mode={theme}
                selected={preset.id === themeName}
                onSelect={previewThemeName}
              />
            ))}
          </div>
          <div className="sticky bottom-3 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface/90 px-4 py-3 shadow-card backdrop-blur-md">
            <PrimaryButton type="button" disabled={!dirty} onClick={() => setThemeName(themeName)}>
              Save theme
            </PrimaryButton>
            <SecondaryButton type="button" disabled={!dirty} onClick={resetThemeName}>
              Reset
            </SecondaryButton>
            <p className="text-caption leading-5 text-muted-foreground" role="status">
              {dirty
                ? `Previewing ${presetLabel(themeName)} — not saved yet.`
                : `Saved theme: ${presetLabel(savedThemeName)}.`}
            </p>
          </div>
        </section>
        <section className="grid gap-4" aria-label="Preview">
          <h2 className="text-sm font-semibold text-foreground">Live preview</h2>
          <ThemeLivePreview />
          <p className="text-caption leading-5 text-muted-foreground">
            The saved theme is kept on this device and applies across the portal. The staff console
            keeps its own operations palette.
          </p>
        </section>
      </div>
    </div>
  );
}
