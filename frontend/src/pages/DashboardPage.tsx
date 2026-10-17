import { Navigate, useParams } from "react-router-dom";
import { NetworkAnalysis } from "@/components/analysis/NetworkAnalysis";
import { PageHeader } from "@/components/ui/DetailGrid";
import { usePageMeta } from "@/hooks/usePageMeta";
import { useAuth } from "@/providers/AuthProvider";

export function LegacyDashboardRedirect() {
  const { code } = useParams();
  return <Navigate to={code ? `/${code}/dashboard` : "/dashboard"} replace />;
}

export function DashboardPage() {
  const { user } = useAuth();
  const { code } = useParams();
  usePageMeta("Dashboard — ISP CENTRIC", "MikroTik, client, and usage analysis.");

  if (user?.dashboardCode && code !== user.dashboardCode) {
    return <Navigate to={`/${user.dashboardCode}/dashboard`} replace />;
  }

  return (
    <div className="page-shell py-8">
      <PageHeader title="Dashboard" description="Router health, client states, and today's PPPoE and hotspot usage." />
      <NetworkAnalysis />
    </div>
  );
}
