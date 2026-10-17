import type { LucideIcon } from "lucide-react";

export function FeatureCard({
  title,
  description,
  icon: Icon,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
}) {
  return (
    <article className="group h-full rounded-2xl border border-border bg-surface p-5 shadow-card transition duration-brand ease-brand motion-safe:hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-lift">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-secondary text-primary">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </div>
      <h3 className="mt-4 text-base font-semibold text-foreground">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
    </article>
  );
}
