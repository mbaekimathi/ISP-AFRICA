import { Navigate } from "react-router-dom";
import { ProfileForm } from "@/components/profile/ProfileForm";
import { PrimaryButton } from "@/components/ui/Buttons";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { DetailGrid, PageHeader } from "@/components/ui/DetailGrid";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useAuth } from "@/providers/AuthProvider";

export function AccountPage() {
  const { user, ready, logout, saveProfile } = useAuth();
  const accountNumber = user?.clientCode ?? "";
  usePageMeta(
    accountNumber ? `${accountNumber} — ISP CENTRIC` : "Account — ISP CENTRIC",
    accountNumber ? `ISP client account ${accountNumber}.` : "ISP CENTRIC client account access.",
  );

  if (!ready) {
    return <LiveLoad />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (user.status !== "approved") {
    return (
      <div className="page-shell py-8">
        <article className="card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <img
                src={user.photoDataUrl}
                alt={`Profile photo of ${user.firstName} ${user.lastName}`}
                className="h-10 w-10 rounded-full border border-border object-cover"
              />
              <div>
                <h1 className="text-base font-semibold">Waiting for approval</h1>
                <p className="mt-0.5 text-sm text-muted-foreground">The ISP client account stays closed until this registration is approved.</p>
              </div>
            </div>
            <StatusBadge tone="due">Pending</StatusBadge>
          </div>
          <div className="mt-3">
            <DetailGrid
              items={[
                { label: "Name", value: `${user.firstName} ${user.lastName}` },
                { label: "Username", value: user.username },
                { label: "Email", value: user.email },
                { label: "Phone", value: user.phone },
              ]}
            />
          </div>
          <div className="mt-4">
            <PrimaryButton type="button" onClick={logout}>
              Log out
            </PrimaryButton>
          </div>
        </article>
      </div>
    );
  }

  return (
    <div className="page-shell py-8">
      <PageHeader title="Profile" description="View and edit the details on this ISP client account." />
      <article className="card mt-6 p-5">
        <DetailGrid
          items={[{ label: "Account", value: accountNumber || "Not assigned" }]}
        />
      </article>
      <ProfileForm
        idPrefix="client-profile"
        account={{
          firstName: user.firstName,
          lastName: user.lastName,
          username: user.username,
          email: user.email,
          phone: user.phone,
          loginCode: user.loginCode,
          photoDataUrl: user.photoDataUrl,
        }}
        onSubmit={saveProfile}
      />
    </div>
  );
}
