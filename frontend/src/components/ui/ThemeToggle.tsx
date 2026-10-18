import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/providers/ThemeProvider";

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      className={`inline-flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-surface/80 text-foreground shadow-xs transition duration-fast ease-out hover:bg-surface active:scale-[0.97] ${className}`}
      onClick={toggleTheme}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-pressed={isDark}
    >
      <span className="relative flex h-4 w-4 items-center justify-center">
        <Sun
          className="absolute h-4 w-4 rotate-0 scale-100 text-amber-500 transition-all duration-200 ease-out dark:-rotate-90 dark:scale-0"
          aria-hidden="true"
        />
        <Moon
          className="absolute h-4 w-4 rotate-90 scale-0 text-indigo-400 transition-all duration-200 ease-out dark:rotate-0 dark:scale-100"
          aria-hidden="true"
        />
      </span>
    </button>
  );
}
