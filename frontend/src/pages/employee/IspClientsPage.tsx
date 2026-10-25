import { Activity } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { LiveLoad } from "@/components/ui/LiveLoad";
import { DetailGrid, PageHeader } from "@/components/ui/DetailGrid";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { usePageMeta } from "@/hooks/usePageMeta";
import { clientHomePath, listAccountsForReview, type PublicAccount } from "@/lib/accounts";
import { employeeHomePath, employeePage } from "@/lib/employees";
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
      <div className="mt-4 flex flex-wrap gap-2">
        <SecondaryButton to={employeePage(employee, "/performance")}>
          <Activity className="h-4 w-4" aria-hidden="true" />
          Analytics &amp; system performance
        </SecondaryButton>
      </div>
      {message ? (
        <p className="notice mt-4" role="alert">
          {message}
        </p>
      ) : null}
      {!loaded && !message ? (
        <div className="mt-6 grid gap-4" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <div key={index} className="card p-5">
              <div className="flex items-center gap-3">
                <div className="skeleton h-10 w-10 rounded-full" />
                <div className="grid flex-1 gap-2">
                  <div className="skeleton h-4 w-1/3" />
                  <div className="skeleton h-3 w-1/2" />
                </div>
              </div>
            </div>
          ))}
          <span className="sr-only">Loading ISP clients…</span>
        </div>
      ) : null}
      {loaded && clients.length === 0 && !message ? (
        <p className="panel mt-6 p-5 text-sm text-muted-foreground">No ISP clients are registered yet.</p>
      ) : (
        <div className="mt-6 grid gap-4">
          {clients.map((client) => (
            <article key={client.id} className="card p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <img src={client.photoDataUrl} alt="" className="h-10 w-10 rounded-full border border-border object-cover" />
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
