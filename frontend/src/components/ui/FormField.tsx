import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function FormField({
  id,
  label,
  error,
  children,
  hint,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <div className={cn(error && "[&_.field]:border-destructive")}>{children}</div>
      {hint && !error ? (
        <p id={`${id}-hint`} className="text-xs leading-5 text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function FormPicker({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="grid gap-1.5" role="tablist" aria-label={label}>
      <div
        className="grid gap-1 rounded-lg bg-surface-muted p-1"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((option) => {
          const selected = value === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={cn(
                "min-h-9 rounded-md px-2 text-sm font-medium",
                selected ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground",
              )}
              onClick={() => onChange(option.id)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
