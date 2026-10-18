import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  applyTheme,
  applyThemeName,
  readStoredTheme,
  readStoredThemeName,
  storeTheme,
  storeThemeName,
  type Theme,
  type ThemeName,
} from "@/lib/theme";

type ThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  themeName: ThemeName;
  savedThemeName: ThemeName;
  setThemeName: (name: ThemeName) => void;
  previewThemeName: (name: ThemeName) => void;
  resetThemeName: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function resolveInitialTheme(): Theme {
  return readStoredTheme() ?? "dark";
}

function resolveInitialThemeName(): ThemeName {
  return readStoredThemeName() ?? "classic";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(resolveInitialTheme);
  const [themeName, setThemeNameState] = useState<ThemeName>(resolveInitialThemeName);
  const [savedThemeName, setSavedThemeName] = useState<ThemeName>(themeName);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    applyThemeName(themeName);
  }, [themeName]);

  const setTheme = useCallback((next: Theme) => {
    storeTheme(next);
    setThemeState(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [setTheme, theme]);

  const setThemeName = useCallback((next: ThemeName) => {
    storeThemeName(next);
    setThemeNameState(next);
    setSavedThemeName(next);
  }, []);

  const previewThemeName = useCallback((next: ThemeName) => {
    setThemeNameState(next);
  }, []);

  const resetThemeName = useCallback(() => {
    setThemeNameState(savedThemeName);
  }, [savedThemeName]);

  const value = useMemo(
    () => ({
      theme,
      setTheme,
      toggleTheme,
      themeName,
      savedThemeName,
      setThemeName,
      previewThemeName,
      resetThemeName,
    }),
    [theme, setTheme, toggleTheme, themeName, savedThemeName, setThemeName, previewThemeName, resetThemeName],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
