import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { PageHeader } from "@/components/ui/DetailGrid";
import { FormField } from "@/components/ui/FormField";
import { usePageMeta } from "@/hooks/usePageMeta";
import { fileToCompanyLogo } from "@/lib/accounts";
import { apiRequest } from "@/lib/api";
import { useAuth } from "@/providers/AuthProvider";

type CompanyDraft = {
  name: string;
  email: string;
  phone: string;
  website: string;
  address: string;
  logoDataUrl: string;
};

type CompanyRecord = CompanyDraft & {
  updatedAt: string | null;
};

const emptyDraft: CompanyDraft = {
  name: "",
  email: "",
  phone: "",
  website: "",
  address: "",
  logoDataUrl: "",
};

function draftFrom(record: CompanyRecord | null): CompanyDraft {
  if (!record) return emptyDraft;
  return {
    name: record.name,
    email: record.email,
    phone: record.phone,
    website: record.website,
    address: record.address,
    logoDataUrl: record.logoDataUrl,
  };
}

export function IspCompanyPage() {
  const { user, ready } = useAuth();
  usePageMeta("ISP COMPANY SETTINGS — ISP CENTRIC", "Update this ISP company's details and logo.");
  const [draft, setDraft] = useState<CompanyDraft>(emptyDraft);
  const [, setSaved] = useState<CompanyRecord | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const apply = useCallback((record: CompanyRecord | null) => {
    setSaved(record);
    setDraft(draftFrom(record));
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!user || user.status !== "approved") return;
    let stopped = false;
    apiRequest<{ company: CompanyRecord | null }>("/api/company")
      .then((body) => {
        if (!stopped) apply(body.company);
      })
      .catch((cause: unknown) => {
        if (!stopped) {
          setLoaded(true);
          setError(cause instanceof Error ? cause.message : "Company details could not be loaded.");
        }
      });
    return () => {
      stopped = true;
    };
  }, [apply, user]);

  function update(field: keyof CompanyDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
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

  return (
    <div className="page-shell py-8">
      <PageHeader
        title="Company"
        description="Set the ISP company name, contact details, and logo shown on this account's portal pages."
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
        className="form-card mt-6 max-w-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          setNotice("");
          setPending(true);
          apiRequest<{ company: CompanyRecord | null }>("/api/company", {
            method: "POST",
            body: JSON.stringify(draft),
          })
            .then((body) => {
              apply(body.company);
              setNotice("Saved — the company details are up to date.");
            })
            .catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : "Company details could not be saved.");
            })
            .finally(() => setPending(false));
        }}
      >
        <div className="grid gap-4">
          <FormField id="company-logo" label="Company logo" hint="Shown on portal pages. JPEG, PNG, or WebP.">
            <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              {draft.logoDataUrl ? (
                <img src={draft.logoDataUrl} alt="Company logo" className="h-24 w-24 rounded-xl object-cover" />
              ) : (
                <span className="flex h-24 w-24 items-center justify-center rounded-xl border border-dashed border-border text-xs text-muted-foreground">
                  No logo
                </span>
              )}
              <div className="grid gap-2">
                <input
                  id="company-logo"
                  type="file"
                  accept="image/*"
                  className="field py-2"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    void fileToCompanyLogo(file)
                      .then((logo) => update("logoDataUrl", logo))
                      .catch((cause: unknown) => {
                        setError(cause instanceof Error ? cause.message : "Could not use that image.");
                      });
                  }}
                />
                {draft.logoDataUrl ? (
                  <SecondaryButton type="button" onClick={() => update("logoDataUrl", "")}>
                    Remove logo
                  </SecondaryButton>
                ) : null}
              </div>
            </div>
          </FormField>
          <FormField id="company-name" label="Company name">
            <input
              id="company-name"
              className="field"
              maxLength={120}
              required
              value={draft.name}
              onChange={(event) => update("name", event.target.value)}
            />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField id="company-email" label="Company email">
              <input
                id="company-email"
                type="email"
                className="field"
                autoComplete="off"
                maxLength={120}
                value={draft.email}
                onChange={(event) => update("email", event.target.value)}
              />
            </FormField>
            <FormField id="company-phone" label="Company phone">
              <input
                id="company-phone"
                type="tel"
                className="field"
                autoComplete="off"
                maxLength={20}
                value={draft.phone}
                onChange={(event) => update("phone", event.target.value)}
              />
            </FormField>
          </div>
          <FormField id="company-website" label="Website" hint="Optional — the company's public site.">
            <input
              id="company-website"
              className="field"
              inputMode="url"
              placeholder="https://example.com"
              maxLength={160}
              value={draft.website}
              onChange={(event) => update("website", event.target.value)}
            />
          </FormField>
          <FormField id="company-address" label="Address" hint="Optional — where the company is based.">
            <input
              id="company-address"
              className="field"
              maxLength={200}
              value={draft.address}
              onChange={(event) => update("address", event.target.value)}
            />
          </FormField>
          <div className="sticky bottom-3 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface/90 px-4 py-3 shadow-card backdrop-blur-md">
            <PrimaryButton type="submit" disabled={pending || !loaded}>
              Save company details
            </PrimaryButton>
          </div>
        </div>
      </form>
    </div>
  );
}
