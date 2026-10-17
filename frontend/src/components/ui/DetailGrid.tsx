export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="max-w-2xl">
      <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">{title}</h1>
      {description ? <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p> : null}
    </header>
  );
}

export function DetailGrid({ items }: { items: { label: string; value: string }[] }) {
  return (
    <dl className="grid sm:grid-cols-2 sm:gap-x-10">
      {items.map((item) => (
        <div key={item.label} className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-x-3 border-b border-border py-2.5">
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className="min-w-0 break-words text-sm font-medium text-foreground">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
