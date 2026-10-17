import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { PrimaryButton } from "@/components/ui/Buttons";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { DetailGrid, PageHeader } from "@/components/ui/DetailGrid";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { clientHomePath, listAccountsForReview, type PublicAccount } from "@/lib/accounts";
import { employeeHomePath } from "@/lib/employees";
import { useAuth } from "@/providers/AuthProvider";
import { useEmployeeAuth } from "@/providers/EmployeeAuthProvider";

export function IspClientsPage() {
  usePageMeta("ISP Clients — ISP CENTRIC", "Every ISP client registered in this system.");
  const { employee, ready } = useEmployeeAuth();
  const { openAsClient } = useAuth();
  const navigate = useNavigate();
  const [clients, setClients] = useState<PublicAccount[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [openingId, setOpeningId] = useState("");

  useEffect(() => {
    if (employee?.role !== "director") return;
    listAccountsForReview()
      .then(setClients)
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : "Could not load ISP clients.");
      })
      .finally(() => setLoaded(true));
  }, [employee?.role]);

  if (!ready) {
    return <LiveLoad label="Loading clients" />;
  }

  if (!employee) {
    return <Navigate to="/employee/login" replace />;
  }

  if (employee.role !== "director") {
    return <Navigate to={employeeHomePath(employee)} replace />;
  }

  return (
    <div className="page-shell py-8">
      <PageHeader
        title="ISP clients"
        description="Every ISP client in this system. Access opens their portal in this browser as that client."
      />
      {message ? (
        <p className="mt-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm" role="alert">
          {message}
        </p>
      ) : null}
      {!loaded && !message ? (
        <p className="mt-6 text-sm text-muted-foreground">Loading ISP clients…</p>
      ) : null}
      {loaded && clients.length === 0 && !message ? (
        <p className="mt-6 rounded-xl border border-border bg-surface p-5 text-sm text-muted-foreground">No ISP clients are registered yet.</p>
      ) : (
        <div className="mt-6 grid gap-4">
          {clients.map((client) => (
            <article key={client.id} className="rounded-xl border border-border bg-surface p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <img src={client.photoDataUrl} alt="" className="h-10 w-10 rounded-full object-cover" />
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold">{client.firstName} {client.lastName}</h2>
                    <StatusBadge tone={client.status === "approved" ? "active" : "due"}>
                      {client.status === "approved" ? "Approved" : "Pending"}
                    </StatusBadge>
                  </div>
                </div>
                <PrimaryButton
                  type="button"
                  disabled={openingId === client.id}
                  onClick={() => {
                    setOpeningId(client.id);
                    setMessage("");
                    openAsClient(client.id)
                      .then((account) => navigate(clientHomePath(account)))
                      .catch((error: unknown) => {
                        setOpeningId("");
                        setMessage(error instanceof Error ? error.message : "Could not open that portal.");
                      });
                  }}
                >
                  {openingId === client.id ? "Opening portal…" : "Open portal"}
                </PrimaryButton>
              </div>
              <div className="mt-3">
                <DetailGrid
                  items={[
                    { label: "Username", value: client.username },
                    { label: "Email", value: client.email },
                    { label: "Phone", value: client.phone },
                    { label: "Login code", value: client.loginCode },
                    { label: "Client code", value: client.clientCode ?? "Not assigned" },
                    { label: "Portal code", value: client.dashboardCode ?? "Not assigned" },
                  ]}
                />
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
