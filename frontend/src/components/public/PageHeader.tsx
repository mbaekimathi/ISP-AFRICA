import { cn } from "@/lib/cn";

type PageHeaderProps = {
  eyebrow: string;
  title: string;
  description?: string;
  /** Heading level — one h1 per page. */
  level?: 1 | 2;
  className?: string;
};

/** Centered page intro: eyebrow, headline, supporting line. */
export function PageHeader({ eyebrow, title, description, level = 1, className }: PageHeaderProps) {
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <header className={cn("mx-auto max-w-2xl text-center", className)}>
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">{eyebrow}</p>
      <Heading className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
        {title}
      </Heading>
      {description ? <p className="mt-4 text-base leading-7 text-muted-foreground">{description}</p> : null}
    </header>
  );
}
