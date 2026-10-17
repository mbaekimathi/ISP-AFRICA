export type PackageClient = {
  id: string;
  name: string;
  routerCount: number;
};

export function routerCountLabel(count: number) {
  if (count === 0) return "No routers yet";
  if (count === 1) return "1 router";
  return `${count} routers`;
}

export function ClientChoices({
  idPrefix,
  clients,
  selected,
  onChange,
}: {
  idPrefix: string;
  clients: PackageClient[];
  selected: string[];
  onChange: (selected: string[]) => void;
}) {
  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  }

  return (
    <div className="sm:col-span-2 grid gap-3">
      <div className="grid gap-1">
        <p className="text-sm font-medium text-foreground">ISP clients</p>
        <p className="text-sm text-muted-foreground">
          Every client starts selected. This package is added to each selected account as a default, so that account can edit it or register a different package.
        </p>
      </div>
      {clients.length === 0 ? (
        <p id={`${idPrefix}-clients`} className="text-sm text-muted-foreground">
          No approved ISP clients are available yet. This package will be added when a client is approved.
        </p>
      ) : (
        <div id={`${idPrefix}-clients`} className="grid gap-2" role="group" aria-label="ISP clients">
          {clients.map((client) => {
            const checked = selected.includes(client.id);
            return (
              <label key={client.id} className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                <input type="checkbox" className="mt-0.5" checked={checked} onChange={() => toggle(client.id)} />
                <span>
                  <span className="font-medium">{client.name}</span>
                  <span className="mt-0.5 block text-muted-foreground">{routerCountLabel(client.routerCount)}</span>
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
