import type { LucideIcon } from "lucide-react";

export function SolutionCard({
  title,
  description,
  icon: Icon,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
}) {
  return (
    <article className="flex h-full flex-col rounded-2xl border border-border bg-surface p-6 shadow-card">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </div>
      <h3 className="mt-5 text-lg font-semibold text-foreground">{title}</h3>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">{description}</p>
    </article>
  );
}
