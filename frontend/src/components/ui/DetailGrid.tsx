const TECHNICAL_VALUE = /^[0-9a-fA-F:.-]+$/;

export function PageHeader({ title }: { title: string; description?: string }) {
  return <h1 className="sr-only">{title}</h1>;
}

export function DetailGrid({ items }: { items: { label: string; value: string }[] }) {
  return (
    <dl className="grid sm:grid-cols-2 sm:gap-x-10">
      {items.map((item) => {
        const technical = TECHNICAL_VALUE.test(item.value) && /[:.]/.test(item.value);
        const numeric = !technical && /\d/.test(item.value);
        return (
          <div
            key={item.label}
            className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-x-3 border-b border-border/70 py-2.5"
          >
            <dt className="text-caption uppercase tracking-wide text-muted-foreground">{item.label}</dt>
            <dd
              className={
                technical
                  ? "min-w-0 break-words font-mono text-sm font-medium tabular text-foreground"
                  : numeric
                    ? "min-w-0 break-words text-sm font-medium tabular text-foreground"
                    : "min-w-0 break-words text-sm font-medium text-foreground"
              }
            >
              {item.value}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
