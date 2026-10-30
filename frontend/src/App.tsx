import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ClientLayout } from "@/components/layout/ClientLayout";
import { EmployeeLayout } from "@/components/layout/EmployeeLayout";
import { PublicLayout } from "@/components/layout/PublicLayout";
import { CompanyAdvertsPage } from "@/pages/employee/CompanyAdvertsPage";
import { CompanyCommunicationsPage } from "@/pages/employee/CompanyCommunicationsPage";
import { CompanyNotificationsPage } from "@/pages/employee/CompanyNotificationsPage";
import { CompanyNotificationSettingsPage } from "@/pages/employee/CompanyNotificationSettingsPage";
import { CompanyGatewayControlsPage } from "@/pages/employee/CompanyGatewayControlsPage";
import { CompanyGatewayPage } from "@/pages/employee/CompanyGatewayPage";
import { CompanyPackagesPage } from "@/pages/employee/CompanyPackagesPage";
import { CompanyProfilePage } from "@/pages/employee/CompanyProfilePage";
import { CompanyPaymentsPage } from "@/pages/employee/CompanyPaymentsPage";
import { EmployeeAccountPage } from "@/pages/employee/EmployeeAccountPage";
import { EmployeeDashboardPage } from "@/pages/employee/EmployeeDashboardPage";
import { IspClientsPage } from "@/pages/employee/IspClientsPage";
import { EmployeeLoginPage } from "@/pages/employee/EmployeeLoginPage";
import { EmployeeReviewsPage } from "@/pages/employee/EmployeeReviewsPage";
import { EmployeeSignUpPage } from "@/pages/employee/EmployeeSignUpPage";
import { SystemPerformancePage } from "@/pages/employee/SystemPerformancePage";
import { AccountPage } from "@/pages/AccountPage";
import { BillingsPage } from "@/pages/BillingsPage";
import { GatewayLedgerPage } from "@/pages/GatewayLedgerPage";
import { ClientsPage } from "@/pages/ClientsPage";
import { ClientOnboardPage } from "@/pages/ClientOnboardPage";
import { ClientStaffDashboardPage } from "@/pages/ClientStaffDashboardPage";
import { ClientStaffPage } from "@/pages/ClientStaffPage";
import { ClientTicketsPage } from "@/pages/ClientTicketsPage";
import { ClientUsagePage } from "@/pages/ClientUsagePage";
import { WifiPaymentPage } from "@/pages/WifiPaymentPage";
import { HotspotClientPage } from "@/pages/HotspotClientPage";
import { ImportClientsPage } from "@/pages/ImportClientsPage";
import { PppoeCustomerPage } from "@/pages/PppoeCustomerPage";
import { PppoeCustomerTransactionsPage } from "@/pages/PppoeCustomerTransactionsPage";
import { PppoeRemoteAccessPage } from "@/pages/PppoeRemoteAccessPage";
import { PppoeRegisterPage } from "@/pages/PppoeRegisterPage";
import { IspAdvertsPage } from "@/pages/IspAdvertsPage";
import { IspCompanyPage } from "@/pages/IspCompanyPage";
import { IspThemePage } from "@/pages/IspThemePage";
import { IspPackagePage } from "@/pages/IspPackagePage";
import { IspCommunicationsPage } from "@/pages/IspCommunicationsPage";
import { IspNotificationsPage } from "@/pages/IspNotificationsPage";
import { IspNotificationSettingsPage } from "@/pages/IspNotificationSettingsPage";
import { IspPaymentsPage } from "@/pages/IspPaymentsPage";
import { DashboardPage, LegacyDashboardRedirect } from "@/pages/DashboardPage";
import { MikrotikLivePage } from "@/pages/MikrotikLivePage";
import { MikrotikHotspotPage, MikrotikPortPage, MikrotikPppoePage, MikrotikRecoveryPage, MikrotikRouterSetupPage } from "@/pages/MikrotikSetupPages";
import { MikrotiksPage } from "@/pages/MikrotiksPage";
import { LoginPage } from "@/pages/LoginPage";
import { OnboardMikrotikPage } from "@/pages/OnboardMikrotikPage";
import { ReviewsPage } from "@/pages/ReviewsPage";
import { SectionPage } from "@/pages/SectionPage";
import { SignUpPage } from "@/pages/SignUpPage";
import { AboutPage } from "@/pages/public/AboutPage";
import { FeaturesPage } from "@/pages/public/FeaturesPage";
import { HowItWorksPage } from "@/pages/public/HowItWorksPage";
import { SolutionsPage } from "@/pages/public/SolutionsPage";
import { TopPage } from "@/pages/public/TopPage";
import { DemoPage, PrivacyPage, TermsPage } from "@/pages/SitePages";
import { AuthProvider } from "@/providers/AuthProvider";
import { EmployeeAuthProvider } from "@/providers/EmployeeAuthProvider";

const portalRoles = ["isp-technician", "isp-customercare", "isp-manager"] as const;

const clientPages = (
  <>
    <Route path="dashboard" element={<DashboardPage />} />
    <Route path="mikrotiks" element={<MikrotiksPage />} />
    <Route path="mikrotiks/onboard" element={<OnboardMikrotikPage />} />
    <Route path="mikrotiks/import-clients" element={<ImportClientsPage />} />
    <Route path="mikrotiks/:deviceId/ports" element={<MikrotikPortPage />} />
    <Route path="mikrotiks/:deviceId/pppoe" element={<MikrotikPppoePage />} />
    <Route path="mikrotiks/:deviceId/hotspot" element={<MikrotikHotspotPage />} />
    <Route path="mikrotiks/:deviceId/setup" element={<MikrotikRouterSetupPage />} />
    <Route path="mikrotiks/:deviceId/recovery" element={<MikrotikRecoveryPage />} />
    <Route path="mikrotiks/:deviceId" element={<MikrotikLivePage />} />
    <Route path="pppoe/register" element={<PppoeRegisterPage />} />
    <Route path="pppoe/:subscriberId" element={<PppoeCustomerPage />} />
    <Route path="pppoe/:subscriberId/transactions" element={<PppoeCustomerTransactionsPage />} />
    <Route path="pppoe/:subscriberId/remote-access" element={<PppoeRemoteAccessPage />} />
    <Route path="clients" element={<ClientsPage key="pppoe" kind="pppoe" />} />
    <Route path="clients/payments" element={<WifiPaymentPage kind="pppoe" />} />
    <Route path="clients/usage" element={<ClientUsagePage kind="pppoe" />} />
    <Route path="clients/hotspot" element={<ClientsPage key="hotspot" kind="hotspot" />} />
    <Route path="clients/hotspot/payments" element={<WifiPaymentPage kind="hotspot" />} />
    <Route path="clients/hotspot/usage" element={<ClientUsagePage kind="hotspot" />} />
    <Route path="hotspot/:purchaseId" element={<HotspotClientPage />} />
    <Route path="hr" element={<ClientStaffPage view="all" />} />
    <Route path="hr/pending" element={<ClientStaffPage view="pending" />} />
    <Route path="billings" element={<BillingsPage />} />
    <Route path="billings/gateway" element={<GatewayLedgerPage />} />
    <Route path="account" element={<AccountPage />} />
    <Route path="account/settings" element={<SectionPage title="Account settings" />} />
    <Route path="account/settings/isp-company" element={<IspCompanyPage />} />
    <Route path="account/settings/isp-company/company" element={<IspCompanyPage />} />
    <Route path="account/settings/isp-company/profile" element={<Navigate to="/account/settings/isp-company" replace />} />
    <Route path="account/settings/isp-company/theme" element={<IspThemePage />} />
    <Route path="account/settings/isp-package" element={<IspPackagePage />} />
    <Route path="account/settings/isp-payments" element={<IspPaymentsPage />} />
    <Route path="account/settings/isp-communications" element={<IspCommunicationsPage />} />
    <Route path="account/settings/isp-notifications" element={<IspNotificationsPage />} />
    <Route path="account/settings/isp-notifications/settings" element={<IspNotificationSettingsPage />} />
    <Route path="account/settings/isp-adverts" element={<IspAdvertsPage />} />
    <Route path="reviews" element={<ReviewsPage />} />
  </>
);

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <EmployeeAuthProvider>
        <Routes>
          <Route element={<PublicLayout />}>
            <Route path="/" element={<Navigate to="/top" replace />} />
            <Route path="/top" element={<TopPage />} />
            <Route path="/features" element={<FeaturesPage />} />
            <Route path="/solutions" element={<SolutionsPage />} />
            <Route path="/how-it-works" element={<HowItWorksPage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="/demo" element={<DemoPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignUpPage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="/terms" element={<TermsPage />} />
          </Route>
          <Route element={<ClientLayout />}>
            <Route path="/dashboard/:code" element={<LegacyDashboardRedirect />} />
            {clientPages}
          </Route>
          <Route path="/:code" element={<ClientLayout />}>
            <Route index element={<Navigate to="dashboard" replace />} />
            {clientPages}
          </Route>
          <Route path="/isp-technician/:code" element={<ClientLayout />}>
            <Route index element={<Navigate to="dashboard" replace />} />
            <Route path="dashboard" element={<ClientStaffDashboardPage />} />
            <Route path="tickets" element={<ClientTicketsPage />} />
            <Route path="onboard" element={<ClientOnboardPage />} />
            <Route path="materials" element={<SectionPage title="Materials" />} />
            <Route path="faulty" element={<SectionPage title="Faulty tickets" />} />
            <Route path="account" element={<SectionPage title="My account" />} />
            <Route path="*" element={<Navigate to="dashboard" replace />} />
          </Route>
          <Route path="/isp-customercare/:code" element={<ClientLayout />}>
            <Route index element={<Navigate to="dashboard" replace />} />
            <Route path="dashboard" element={<ClientStaffDashboardPage />} />
            <Route path="tickets" element={<ClientTicketsPage />} />
            <Route path="clients" element={<ClientsPage key="pppoe" kind="pppoe" />} />
            <Route path="clients/hotspot" element={<ClientsPage key="hotspot" kind="hotspot" />} />
            <Route path="*" element={<Navigate to="dashboard" replace />} />
          </Route>
          {portalRoles
            .filter((role) => role !== "isp-technician" && role !== "isp-customercare")
            .map((role) => (
              <Route key={role} path={`/${role}/:code`} element={<ClientLayout />}>
                <Route index element={<Navigate to="dashboard" replace />} />
                <Route path="dashboard" element={<ClientStaffDashboardPage />} />
                <Route path="*" element={<Navigate to="dashboard" replace />} />
              </Route>
            ))}
          <Route element={<EmployeeLayout />}>
            <Route path="/:role/:code/dashboard" element={<EmployeeDashboardPage />} />
            <Route path="/:role/:code/performance" element={<SystemPerformancePage />} />
            <Route path="/:role/:code/clients" element={<IspClientsPage />} />
            <Route path="/:role/:code/account" element={<EmployeeAccountPage />} />
            <Route path="/:role/:code/company-settings" element={<SectionPage title="Company settings" />} />
            <Route path="/:role/:code/company-settings/profile" element={<CompanyProfilePage />} />
            <Route path="/:role/:code/company-settings/profile/profile" element={<CompanyProfilePage />} />
            <Route path="/:role/:code/company-settings/profile/theme" element={<SectionPage title="COMPANY THEME" />} />
            <Route path="/:role/:code/company-settings/packages" element={<CompanyPackagesPage />} />
            <Route path="/:role/:code/company-settings/payments" element={<CompanyPaymentsPage />} />
            <Route path="/:role/:code/company-settings/billings" element={<SectionPage title="COMPANY BILLINGS" />} />
            <Route path="/:role/:code/company-settings/billings/gateway" element={<CompanyGatewayPage />} />
            <Route path="/:role/:code/company-settings/billings/gateway/charges" element={<CompanyGatewayControlsPage />} />
            <Route path="/:role/:code/company-settings/communications" element={<CompanyCommunicationsPage />} />
            <Route path="/:role/:code/company-settings/adverts" element={<CompanyAdvertsPage />} />
            <Route path="/:role/:code/company-settings/notifications" element={<CompanyNotificationsPage />} />
            <Route path="/:role/:code/company-settings/notifications/settings" element={<CompanyNotificationSettingsPage />} />
            <Route path="/:role/:code/reviews" element={<EmployeeReviewsPage />} />
          </Route>
          <Route path="/employee" element={<EmployeeLayout />}>
            <Route index element={<Navigate to="login" replace />} />
            <Route path="dashboard" element={<EmployeeDashboardPage />} />
            <Route path=":code/dashboard" element={<EmployeeDashboardPage />} />
            <Route path="clients" element={<IspClientsPage />} />
            <Route path="login" element={<EmployeeLoginPage />} />
            <Route path="signup" element={<EmployeeSignUpPage />} />
            <Route path="account" element={<EmployeeAccountPage />} />
            <Route path="settings" element={<Navigate to="/employee/company-settings" replace />} />
            <Route path="company-settings" element={<SectionPage title="Company settings" />} />
            <Route path="company-settings/profile" element={<CompanyProfilePage />} />
            <Route path="company-settings/profile/profile" element={<CompanyProfilePage />} />
            <Route path="company-settings/profile/theme" element={<SectionPage title="COMPANY THEME" />} />
            <Route path="company-settings/packages" element={<CompanyPackagesPage />} />
            <Route path="company-settings/payments" element={<CompanyPaymentsPage />} />
            <Route path="company-settings/billings" element={<SectionPage title="COMPANY BILLINGS" />} />
            <Route path="company-settings/billings/gateway" element={<CompanyGatewayPage />} />
            <Route path="company-settings/billings/gateway/charges" element={<CompanyGatewayControlsPage />} />
            <Route path="company-settings/communications" element={<CompanyCommunicationsPage />} />
            <Route path="company-settings/adverts" element={<CompanyAdvertsPage />} />
            <Route path="company-settings/notifications" element={<CompanyNotificationsPage />} />
            <Route path="company-settings/notifications/settings" element={<CompanyNotificationSettingsPage />} />
            <Route path="company-settings/isp-notifications" element={<Navigate to="/employee/company-settings/notifications" replace />} />
            <Route path="company-settings/isp-company" element={<Navigate to="/employee/company-settings/profile" replace />} />
            <Route path="company-settings/isp-package" element={<Navigate to="/employee/company-settings/packages" replace />} />
            <Route path="company-settings/isp-payments" element={<Navigate to="/employee/company-settings/payments" replace />} />
            <Route path="company-settings/isp-communications" element={<Navigate to="/employee/company-settings/communications" replace />} />
            <Route path="reviews" element={<EmployeeReviewsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </EmployeeAuthProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
