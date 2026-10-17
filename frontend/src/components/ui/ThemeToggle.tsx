import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/providers/ThemeProvider";

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      className={`inline-flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-surface/80 text-foreground shadow-sm transition duration-brand ease-brand hover:bg-surface ${className}`}
      onClick={toggleTheme}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-pressed={isDark}
    >
      {isDark ? <Sun className="h-4 w-4" aria-hidden="true" /> : <Moon className="h-4 w-4" aria-hidden="true" />}
    </button>
  );
}
