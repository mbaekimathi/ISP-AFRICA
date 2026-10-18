export const THEME_STORAGE_KEY = "isp-centric-theme";
export const THEME_NAME_STORAGE_KEY = "isp-centric-theme-name";

export type Theme = "light" | "dark";
export type ThemeName =
  | "classic"
  | "cobalt"
  | "ocean"
  | "evergreen"
  | "plum"
  | "burgundy"
  | "bronze"
  | "graphite";

export type ThemePreset = {
  id: ThemeName;
  label: string;
  description: string;
  swatch: string[];
};

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: "classic",
    label: "Classic",
    description: "Indigo and cyan — the default ISP CENTRIC palette.",
    swatch: ["#4f46e5", "#06b6d4", "#1e1b4b"],
  },
  {
    id: "cobalt",
    label: "Cobalt",
    description: "Deep blue and cyan for a sharp, professional feel.",
    swatch: ["#1d4ed8", "#0891b2", "#172554"],
  },
  {
    id: "ocean",
    label: "Ocean",
    description: "Sky blue and teal for a cool, composed feel.",
    swatch: ["#0284c7", "#0d9488", "#082f49"],
  },
  {
    id: "evergreen",
    label: "Evergreen",
    description: "Deep green and cyan for a calm, established feel.",
    swatch: ["#047857", "#0e7490", "#022c22"],
  },
  {
    id: "plum",
    label: "Plum",
    description: "Deep purple and berry for a distinguished feel.",
    swatch: ["#6b21a8", "#be185d", "#3b0764"],
  },
  {
    id: "burgundy",
    label: "Burgundy",
    description: "Wine and amber for a refined, executive feel.",
    swatch: ["#9f1239", "#b45309", "#4c0519"],
  },
  {
    id: "bronze",
    label: "Bronze",
    description: "Warm bronze and teal for a confident, premium feel.",
    swatch: ["#92400e", "#0f766e", "#451a03"],
  },
  {
    id: "graphite",
    label: "Graphite",
    description: "Slate and cyan for a neutral, precise feel.",
    swatch: ["#475569", "#0891b2", "#020617"],
  },
];

export function isThemeName(value: string | null): value is ThemeName {
  return THEME_PRESETS.some((preset) => preset.id === value);
}

export function readStoredThemeName(): ThemeName | null {
  try {
    const stored = window.localStorage.getItem(THEME_NAME_STORAGE_KEY);
    return isThemeName(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function storeThemeName(name: ThemeName) {
  try {
    window.localStorage.setItem(THEME_NAME_STORAGE_KEY, name);
  } catch {
    // Preference stays in memory when storage is blocked.
  }
}

function syncThemeColorMeta() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const background = getComputedStyle(document.documentElement).getPropertyValue("--background").trim();
  if (background) meta.setAttribute("content", background);
}

export function applyThemeName(name: ThemeName) {
  const root = document.documentElement;
  for (const preset of THEME_PRESETS) {
    root.classList.remove(`theme-${preset.id}`);
  }
  root.classList.add(`theme-${name}`);
  syncThemeColorMeta();
}

export function isTheme(value: string | null): value is Theme {
  return value === "light" || value === "dark";
}

export function getSystemTheme(): Theme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function readStoredTheme(): Theme | null {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function storeTheme(theme: Theme) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Preference stays in memory when storage is blocked.
  }
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  syncThemeColorMeta();
}
