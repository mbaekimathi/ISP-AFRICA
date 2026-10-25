import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { ExternalLink, Megaphone } from "lucide-react";
import { DestructiveButton, PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { PageHeader } from "@/components/ui/DetailGrid";
import { FormField } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { clientPage, fileToPackageImage } from "@/lib/accounts";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/providers/AuthProvider";

type Advert = {
  id: string;
  name: string;
  website: string;
  imageDataUrl: string;
  enabled: boolean;
};

type AdvertDraft = {
  name: string;
  website: string;
  imageDataUrl: string;
};

const emptyDraft: AdvertDraft = { name: "", website: "", imageDataUrl: "" };

export function IspAdvertsPage() {
  const { user, ready } = useAuth();
  usePageMeta(
    "ISP ADVERTS — ISP CENTRIC",
    "Register advertising partners and enable or disable their adverts.",
  );
  const [adverts, setAdverts] = useState<Advert[]>([]);
  const [draft, setDraft] = useState<AdvertDraft>(emptyDraft);
  const [editingId, setEditingId] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!user || user.status !== "approved" || !user.advertsEnabled) return;
    let stopped = false;
    apiRequest<{ adverts: Advert[] }>("/api/adverts")
      .then((body) => {
        if (!stopped) {
          setAdverts(body.adverts);
          setLoaded(true);
        }
      })
      .catch((cause: unknown) => {
        if (!stopped) {
          setLoaded(true);
          setError(cause instanceof Error ? cause.message : "Adverts could not be loaded.");
        }
      });
    return () => {
      stopped = true;
    };
  }, [user]);

  function update(field: keyof AdvertDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function changeAdvert(advert: Advert, action: string) {
    setBusyId(advert.id);
    setError("");
    setNotice("");
    apiRequest<{ advert?: Advert }>(`/api/adverts/${advert.id}/${action}`, {
      method: "POST",
      body: "{}",
    })
      .then((body) => {
        if (action === "delete") {
          setAdverts((current) => current.filter((item) => item.id !== advert.id));
          if (editingId === advert.id) {
            setEditingId("");
            setDraft(emptyDraft);
          }
          setNotice(`${advert.name} was removed.`);
        } else if (body.advert) {
          setAdverts((current) => current.map((item) => (item.id === advert.id ? body.advert! : item)));
          setNotice(
            body.advert.enabled ? `${advert.name} is enabled.` : `${advert.name} is disabled.`,
          );
        }
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "That advert could not be updated.");
      })
      .finally(() => setBusyId(""));
  }

  if (!ready) {
    return <LiveLoad label="Loading account" />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (user.status !== "approved") {
    return <Navigate to="/account" replace />;
  }

  if (!user.advertsEnabled) {
    return <Navigate to={clientPage(user, "/account/settings")} replace />;
  }

  return (
    <div className="page-shell py-8">
      <PageHeader
        title="Adverts"
        description="Register advertising partners with their website links, and enable or disable their adverts."
      />
      {error ? (
        <p className="mt-4 notice" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice mt-4 border-success-border bg-success-soft/60" role="status">
          {notice}
        </p>
      ) : null}

      <form
        className="form-card mt-6"
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          setNotice("");
          setPending(true);
          const editing = Boolean(editingId);
          apiRequest<{ advert: Advert }>(
            editing ? `/api/adverts/${editingId}/edit` : "/api/adverts",
            { method: "POST", body: JSON.stringify(draft) },
          )
            .then((body) => {
              setAdverts((current) =>
                editing
                  ? current.map((item) => (item.id === editingId ? body.advert : item))
                  : [...current, body.advert].sort((a, b) => a.name.localeCompare(b.name)),
              );
              setDraft(emptyDraft);
              setEditingId("");
              setNotice(editing ? `${body.advert.name} was updated.` : `${body.advert.name} is registered.`);
            })
            .catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : "That partner could not be saved.");
            })
            .finally(() => setPending(false));
        }}
      >
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">{editingId ? "Edit partner" : "Register a partner"}</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Add each partner's name, website link, and advert image — then enable their advert when it should run.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField id="advert-name" label="Partner name">
            <input
              id="advert-name"
              className="field"
              maxLength={120}
              required
              value={draft.name}
              onChange={(event) => update("name", event.target.value)}
            />
          </FormField>
          <FormField id="advert-website" label="Website link" hint="The page this advert opens.">
            <input
              id="advert-website"
              className="field"
              inputMode="url"
              placeholder="https://example.com"
              maxLength={255}
              required
              value={draft.website}
              onChange={(event) => update("website", event.target.value)}
            />
          </FormField>
        </div>
        <FormField id="advert-image" label="Advert image" hint="JPEG, PNG, or WebP — saved as a 640 × 360 banner.">
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            {draft.imageDataUrl ? (
              <img src={draft.imageDataUrl} alt="Advert preview" className="h-28 w-48 rounded-xl object-cover" />
            ) : (
              <span className="flex h-28 w-48 items-center justify-center rounded-xl border border-dashed border-border text-xs text-muted-foreground">
                No image
              </span>
            )}
            <div className="grid gap-2">
              <input
                id="advert-image"
                type="file"
                accept="image/*"
                className="field py-2"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  void fileToPackageImage(file)
                    .then((image) => update("imageDataUrl", image))
                    .catch((cause: unknown) => {
                      setError(cause instanceof Error ? cause.message : "Could not use that image.");
                    });
                }}
              />
              {draft.imageDataUrl ? (
                <SecondaryButton type="button" onClick={() => update("imageDataUrl", "")}>
                  Remove image
                </SecondaryButton>
              ) : null}
            </div>
          </div>
        </FormField>
        <div className="flex flex-wrap items-center gap-3">
          <PrimaryButton type="submit" disabled={pending || !loaded || !draft.imageDataUrl}>
            {editingId ? "Save partner" : "Register partner"}
          </PrimaryButton>
          {editingId ? (
            <SecondaryButton
              type="button"
              onClick={() => {
                setEditingId("");
                setDraft(emptyDraft);
              }}
            >
              Cancel edit
            </SecondaryButton>
          ) : null}
        </div>
      </form>

      <section className="mt-8" aria-labelledby="partner-adverts">
        <h2 id="partner-adverts" className="text-lg font-semibold">
          Partner adverts
        </h2>
        {!loaded && !error ? (
          <p className="mt-4 text-sm text-muted-foreground">Loading adverts…</p>
        ) : adverts.length === 0 ? (
          <p className="panel mt-4 p-5 text-sm text-muted-foreground">No partners are registered yet.</p>
        ) : (
          <div className="mt-4 grid gap-4">
            {adverts.map((advert) => (
              <article key={advert.id} className="card p-5">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex min-w-0 items-center gap-4">
                    {advert.imageDataUrl ? (
                      <img
                        src={advert.imageDataUrl}
                        alt=""
                        className="h-16 w-28 shrink-0 rounded-lg border border-border object-cover"
                      />
                    ) : (
                      <span className="flex h-16 w-28 shrink-0 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground">
                        <Megaphone className="h-5 w-5" aria-hidden="true" />
                      </span>
                    )}
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold">{advert.name}</h3>
                        <StatusBadge tone={advert.enabled ? "active" : "disabled"}>
                          {advert.enabled ? "Enabled" : "Disabled"}
                        </StatusBadge>
                      </div>
                      <a
                        href={advert.website}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-flex items-center gap-1 break-all text-sm text-primary hover:underline"
                      >
                        {advert.website}
                        <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      </a>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <SecondaryButton
                      type="button"
                      disabled={busyId === advert.id}
                      onClick={() => {
                        setEditingId(advert.id);
                        setDraft({ name: advert.name, website: advert.website, imageDataUrl: advert.imageDataUrl });
                      }}
                    >
                      Edit
                    </SecondaryButton>
                    <SecondaryButton
                      type="button"
                      disabled={busyId === advert.id}
                      onClick={() => changeAdvert(advert, advert.enabled ? "disable" : "enable")}
                    >
                      {advert.enabled ? "Disable" : "Enable"}
                    </SecondaryButton>
                    <DestructiveButton
                      type="button"
                      disabled={busyId === advert.id}
                      onClick={() => changeAdvert(advert, "delete")}
                    >
                      Delete
                    </DestructiveButton>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
