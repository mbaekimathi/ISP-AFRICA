import { useMemo, useState } from "react";

export type PackageRouter = {
  id: string;
  name: string;
  site: string;
  clientName: string;
};

export function routerLabel(router: PackageRouter, showClient: boolean) {
  const place = router.site ? `${router.name} · ${router.site}` : router.name;
  return showClient && router.clientName ? `${place} · ${router.clientName}` : place;
}

type SiteGroup = {
  site: string;
  routers: PackageRouter[];
};

type ClientGroup = {
  client: string;
  sites: SiteGroup[];
};

function groupedRouters(routers: PackageRouter[], showClient: boolean, query: string) {
  const needle = query.trim().toLowerCase();
  const visible = routers.filter((router) => routerLabel(router, true).toLowerCase().includes(needle));
  const clients = new Map<string, Map<string, PackageRouter[]>>();
  for (const router of visible) {
    const client = showClient ? router.clientName || "ISP client" : "";
    const site = router.site || "No site";
    const sites = clients.get(client) ?? new Map<string, PackageRouter[]>();
    const list = sites.get(site) ?? [];
    list.push(router);
    sites.set(site, list);
    clients.set(client, sites);
  }
  const groups: ClientGroup[] = [];
  for (const [client, sites] of clients) {
    groups.push({
      client,
      sites: [...sites.entries()].map(([site, items]) => ({ site, routers: items })),
    });
  }
  return { visible, groups };
}

export function RouterChoices({
  idPrefix,
  routers,
  selected,
  showClient,
  hint,
  onChange,
}: {
  idPrefix: string;
  routers: PackageRouter[];
  selected: string[];
  showClient: boolean;
  hint: string;
  onChange: (selected: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const { visible, groups } = useMemo(
    () => groupedRouters(routers, showClient, query),
    [routers, showClient, query],
  );

  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  }

  function toggleMany(ids: string[], allSelected: boolean) {
    if (allSelected) {
      onChange(selected.filter((id) => !ids.includes(id)));
      return;
    }
    onChange([...selected, ...ids.filter((id) => !selected.includes(id))]);
  }

  return (
    <div className="sm:col-span-2 grid gap-3">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <label htmlFor={`${idPrefix}-router-search`} className="text-sm font-medium text-foreground">
            Routers
          </label>
          <p className="text-sm text-muted-foreground">
            {selected.length} selected
          </p>
        </div>
        <p className="text-sm text-muted-foreground">{hint}</p>
        {routers.length > 0 ? (
          <input
            id={`${idPrefix}-router-search`}
            className="field"
            placeholder="Find a router by name, site, or client"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        ) : null}
      </div>
      {routers.length === 0 ? (
        <p id={`${idPrefix}-routers`} className="text-sm text-muted-foreground">
          No routers are registered yet.
        </p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No routers match that search.</p>
      ) : (
        <div id={`${idPrefix}-routers`} className="grid gap-3" role="group" aria-label="Routers">
          {groups.map((client) => (
            <div key={client.client || "account"} className="grid gap-3 rounded-xl border border-border p-3">
              {showClient ? <h3 className="text-sm font-semibold">{client.client}</h3> : null}
              {client.sites.map((site) => {
                const ids = site.routers.map((router) => router.id);
                const allSelected = ids.every((id) => selected.includes(id));
                return (
                  <div key={site.site} className="grid gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h4 className="text-sm font-medium text-muted-foreground">{site.site}</h4>
                      <button
                        type="button"
                        className="text-sm font-semibold text-primary"
                        onClick={() => toggleMany(ids, allSelected)}
                      >
                        {allSelected ? "Clear site" : "Select site"}
                      </button>
                    </div>
                    <div className="grid gap-2">
                      {site.routers.map((router) => {
                        const checked = selected.includes(router.id);
                        return (
                          <label
                            key={router.id}
                            className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                          >
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              checked={checked}
                              onChange={() => toggle(router.id)}
                            />
                            <span>{router.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
