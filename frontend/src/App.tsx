import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ClientLayout } from "@/components/layout/ClientLayout";
import { EmployeeLayout } from "@/components/layout/EmployeeLayout";
import { PublicLayout } from "@/components/layout/PublicLayout";
import { CompanyCommunicationsPage } from "@/pages/employee/CompanyCommunicationsPage";
import { CompanyPackagesPage } from "@/pages/employee/CompanyPackagesPage";
import { CompanyPaymentsPage } from "@/pages/employee/CompanyPaymentsPage";
import { EmployeeAccountPage } from "@/pages/employee/EmployeeAccountPage";
import { EmployeeDashboardPage } from "@/pages/employee/EmployeeDashboardPage";
import { IspClientsPage } from "@/pages/employee/IspClientsPage";
import { EmployeeLoginPage } from "@/pages/employee/EmployeeLoginPage";
import { EmployeeReviewsPage } from "@/pages/employee/EmployeeReviewsPage";
import { EmployeeSignUpPage } from "@/pages/employee/EmployeeSignUpPage";
import { AccountPage } from "@/pages/AccountPage";
import { BillingsPage } from "@/pages/BillingsPage";
import { ClientsPage } from "@/pages/ClientsPage";
import { ClientUsagePage } from "@/pages/ClientUsagePage";
import { WifiPaymentPage } from "@/pages/WifiPaymentPage";
import { PppoeCustomerPage } from "@/pages/PppoeCustomerPage";
import { PppoeRegisterPage } from "@/pages/PppoeRegisterPage";
import { IspPackagePage } from "@/pages/IspPackagePage";
import { IspCommunicationsPage } from "@/pages/IspCommunicationsPage";
import { IspPaymentsPage } from "@/pages/IspPaymentsPage";
import { DashboardPage, LegacyDashboardRedirect } from "@/pages/DashboardPage";
import { MikrotikLivePage } from "@/pages/MikrotikLivePage";
import { MikrotikHotspotPage, MikrotikPortPage, MikrotikPppoePage, MikrotikRecoveryPage, MikrotikRouterSetupPage } from "@/pages/MikrotikSetupPages";
import { MikrotiksPage } from "@/pages/MikrotiksPage";
import { LandingPage } from "@/pages/LandingPage";
import { LoginPage } from "@/pages/LoginPage";
import { OnboardMikrotikPage } from "@/pages/OnboardMikrotikPage";
import { ReviewsPage } from "@/pages/ReviewsPage";
import { SectionPage } from "@/pages/SectionPage";
import { SignUpPage } from "@/pages/SignUpPage";
import { DemoPage, PrivacyPage, TermsPage } from "@/pages/SitePages";
import { AuthProvider } from "@/providers/AuthProvider";
import { EmployeeAuthProvider } from "@/providers/EmployeeAuthProvider";

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <EmployeeAuthProvider>
        <Routes>
          <Route element={<PublicLayout />}>
            <Route path="/" element={<LandingPage />} />
            <Route path="/demo" element={<DemoPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignUpPage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="/terms" element={<TermsPage />} />
          </Route>
          <Route element={<ClientLayout />}>
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/dashboard/:code" element={<LegacyDashboardRedirect />} />
            <Route path="/:code/dashboard" element={<DashboardPage />} />
            <Route path="/mikrotiks" element={<MikrotiksPage />} />
            <Route path="/:code/mikrotiks" element={<MikrotiksPage />} />
            <Route path="/mikrotiks/onboard" element={<OnboardMikrotikPage />} />
            <Route path="/:code/mikrotiks/onboard" element={<OnboardMikrotikPage />} />
            <Route path="/mikrotiks/import-clients" element={<SectionPage title="Import Clients" />} />
            <Route path="/:code/mikrotiks/import-clients" element={<SectionPage title="Import Clients" />} />
            <Route path="/mikrotiks/:deviceId/ports" element={<MikrotikPortPage />} />
            <Route path="/:code/mikrotiks/:deviceId/ports" element={<MikrotikPortPage />} />
            <Route path="/mikrotiks/:deviceId/pppoe" element={<MikrotikPppoePage />} />
            <Route path="/:code/mikrotiks/:deviceId/pppoe" element={<MikrotikPppoePage />} />
            <Route path="/mikrotiks/:deviceId/hotspot" element={<MikrotikHotspotPage />} />
            <Route path="/:code/mikrotiks/:deviceId/hotspot" element={<MikrotikHotspotPage />} />
            <Route path="/mikrotiks/:deviceId/setup" element={<MikrotikRouterSetupPage />} />
            <Route path="/:code/mikrotiks/:deviceId/setup" element={<MikrotikRouterSetupPage />} />
            <Route path="/mikrotiks/:deviceId/recovery" element={<MikrotikRecoveryPage />} />
            <Route path="/:code/mikrotiks/:deviceId/recovery" element={<MikrotikRecoveryPage />} />
            <Route path="/mikrotiks/:deviceId" element={<MikrotikLivePage />} />
            <Route path="/:code/mikrotiks/:deviceId" element={<MikrotikLivePage />} />
            <Route path="/pppoe/register" element={<PppoeRegisterPage />} />
            <Route path="/:code/pppoe/register" element={<PppoeRegisterPage />} />
            <Route path="/pppoe/:subscriberId" element={<PppoeCustomerPage />} />
            <Route path="/:code/pppoe/:subscriberId" element={<PppoeCustomerPage />} />
            <Route path="/clients" element={<ClientsPage kind="pppoe" />} />
            <Route path="/clients/payments" element={<WifiPaymentPage kind="pppoe" />} />
            <Route path="/clients/usage" element={<ClientUsagePage kind="pppoe" />} />
            <Route path="/clients/hotspot" element={<ClientsPage kind="hotspot" />} />
            <Route path="/clients/hotspot/payments" element={<WifiPaymentPage kind="hotspot" />} />
            <Route path="/clients/hotspot/usage" element={<ClientUsagePage kind="hotspot" />} />
            <Route path="/:code/clients" element={<ClientsPage kind="pppoe" />} />
            <Route path="/:code/clients/payments" element={<WifiPaymentPage kind="pppoe" />} />
            <Route path="/:code/clients/usage" element={<ClientUsagePage kind="pppoe" />} />
            <Route path="/:code/clients/hotspot" element={<ClientsPage kind="hotspot" />} />
            <Route path="/:code/clients/hotspot/payments" element={<WifiPaymentPage kind="hotspot" />} />
            <Route path="/:code/clients/hotspot/usage" element={<ClientUsagePage kind="hotspot" />} />
            <Route path="/billings" element={<BillingsPage />} />
            <Route path="/:code/billings" element={<BillingsPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/:code/account" element={<AccountPage />} />
            <Route path="/account/settings" element={<SectionPage title="Account settings" />} />
            <Route path="/:code/account/settings" element={<SectionPage title="Account settings" />} />
            <Route path="/account/settings/isp-company" element={<SectionPage title="ISP COMPANY SETTINGS" />} />
            <Route path="/:code/account/settings/isp-company" element={<SectionPage title="ISP COMPANY SETTINGS" />} />
            <Route path="/account/settings/isp-company/company" element={<SectionPage title="ISP COMPANY" />} />
            <Route path="/:code/account/settings/isp-company/company" element={<SectionPage title="ISP COMPANY" />} />
            <Route path="/account/settings/isp-company/profile" element={<SectionPage title="PROFILE" />} />
            <Route path="/:code/account/settings/isp-company/profile" element={<SectionPage title="PROFILE" />} />
            <Route path="/account/settings/isp-company/theme" element={<SectionPage title="THEME" />} />
            <Route path="/:code/account/settings/isp-company/theme" element={<SectionPage title="THEME" />} />
            <Route path="/account/settings/isp-package" element={<IspPackagePage />} />
            <Route path="/:code/account/settings/isp-package" element={<IspPackagePage />} />
            <Route path="/account/settings/isp-payments" element={<IspPaymentsPage />} />
            <Route path="/:code/account/settings/isp-payments" element={<IspPaymentsPage />} />
            <Route path="/account/settings/isp-communications" element={<IspCommunicationsPage />} />
            <Route path="/:code/account/settings/isp-communications" element={<IspCommunicationsPage />} />
            <Route path="/reviews" element={<ReviewsPage />} />
            <Route path="/:code/reviews" element={<ReviewsPage />} />
          </Route>
          <Route element={<EmployeeLayout />}>
            <Route path="/:role/:code/dashboard" element={<EmployeeDashboardPage />} />
            <Route path="/:role/:code/clients" element={<IspClientsPage />} />
            <Route path="/:role/:code/account" element={<EmployeeAccountPage />} />
            <Route path="/:role/:code/company-settings" element={<SectionPage title="Company settings" />} />
            <Route path="/:role/:code/company-settings/profile" element={<SectionPage title="COMPANY PROFILE" />} />
            <Route path="/:role/:code/company-settings/profile/profile" element={<SectionPage title="COMPANY PROFILE" />} />
            <Route path="/:role/:code/company-settings/profile/theme" element={<SectionPage title="COMPANY THEME" />} />
            <Route path="/:role/:code/company-settings/packages" element={<CompanyPackagesPage />} />
            <Route path="/:role/:code/company-settings/payments" element={<CompanyPaymentsPage />} />
            <Route path="/:role/:code/company-settings/communications" element={<CompanyCommunicationsPage />} />
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
            <Route path="company-settings/profile" element={<SectionPage title="COMPANY PROFILE" />} />
            <Route path="company-settings/profile/profile" element={<SectionPage title="COMPANY PROFILE" />} />
            <Route path="company-settings/profile/theme" element={<SectionPage title="COMPANY THEME" />} />
            <Route path="company-settings/packages" element={<CompanyPackagesPage />} />
            <Route path="company-settings/payments" element={<CompanyPaymentsPage />} />
            <Route path="company-settings/communications" element={<CompanyCommunicationsPage />} />
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
