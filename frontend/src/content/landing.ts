import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bell,
  Building2,
  Cable,
  BarChart3,
  FileText,
  KeyRound,
  LockKeyhole,
  Radio,
  Receipt,
  Router,
  ScrollText,
  Shield,
  Store,
  Users,
  Wallet,
  Wifi,
  UserRound,
} from "lucide-react";

export const navItems = [
  { label: "Home", href: "/#top" },
  { label: "Features", href: "/#features" },
  { label: "Solutions", href: "/#solutions" },
  { label: "How It Works", href: "/#how-it-works" },
  { label: "About", href: "/#about" },
  { label: "Contact", href: "/#contact" },
] as const;

export type Feature = {
  title: string;
  description: string;
  icon: LucideIcon;
};

export const benefits: Feature[] = [
  {
    title: "Simplified ISP operations",
    description:
      "Keep subscriber care, service setup, and day-to-day follow-up in one working environment.",
    icon: Activity,
  },
  {
    title: "Better billing visibility",
    description:
      "See recurring charges, invoices, and outstanding balances without jumping between tools.",
    icon: Receipt,
  },
  {
    title: "Centralized subscriber records",
    description:
      "Hold account details, assigned services, and status in a single subscriber record.",
    icon: Users,
  },
  {
    title: "Improved payment tracking",
    description:
      "Match recorded payments to invoices so collections stay easier to review.",
    icon: Wallet,
  },
  {
    title: "More efficient network management",
    description:
      "Connect operational context to the packages and services your customers actually use.",
    icon: Router,
  },
  {
    title: "Data-driven business decisions",
    description:
      "Review subscriber and revenue summaries before you change packages or staffing.",
    icon: BarChart3,
  },
];

export const features: Feature[] = [
  {
    title: "Subscriber Management",
    description:
      "Organize customer records, service assignments, and account status in one place.",
    icon: Users,
  },
  {
    title: "Automated Billing",
    description:
      "Prepare recurring charges from the packages you define so billing cycles stay consistent.",
    icon: Receipt,
  },
  {
    title: "Invoice Management",
    description:
      "Create and review invoices tied to subscriber accounts and billing periods.",
    icon: FileText,
  },
  {
    title: "Payment Tracking",
    description: "Record payments against invoices and see what remains outstanding.",
    icon: Wallet,
  },
  {
    title: "Internet Packages",
    description: "Define the plans you sell, including price, speed, and billing interval.",
    icon: Cable,
  },
  {
    title: "Network and Router Integration",
    description:
      "A planned path for connecting operational data from the network devices you already use.",
    icon: Router,
  },
  {
    title: "Hotspot Management",
    description:
      "Intended support for voucher and hotspot-style access alongside traditional subscriptions.",
    icon: Wifi,
  },
  {
    title: "Customer Self-Service Portal",
    description: "A planned space where subscribers can review their own account information.",
    icon: UserRound,
  },
  {
    title: "Reports and Analytics",
    description:
      "Summaries of revenue, collections, and subscriber activity for the people running the business.",
    icon: BarChart3,
  },
  {
    title: "Staff and Permissions",
    description:
      "Separate responsibilities so each team member works within an assigned role.",
    icon: Shield,
  },
  {
    title: "Notifications and Alerts",
    description: "Planned notices for billing events and operational changes that need attention.",
    icon: Bell,
  },
  {
    title: "Audit and Activity Records",
    description: "A record of administrative actions to support accountability inside the team.",
    icon: ScrollText,
  },
];

export const solutions: Feature[] = [
  {
    title: "Fibre ISPs",
    description:
      "Built for providers that sell recurring fibre packages and need subscriber, invoice, and payment records to stay aligned.",
    icon: Cable,
  },
  {
    title: "Wireless ISPs",
    description:
      "Intended for WISPs that manage many sites, packages, and field customers from a shared operational view.",
    icon: Radio,
  },
  {
    title: "Hotspot operators",
    description:
      "Designed to sit beside voucher and access sales, with subscriber and payment history kept in the same product.",
    icon: Wifi,
  },
  {
    title: "Neighbourhood internet providers",
    description:
      "A practical home for smaller teams that know their customers by name and still need orderly billing.",
    icon: Store,
  },
  {
    title: "Regional internet businesses",
    description:
      "Structured so growing operators can add staff, packages, and service areas without splitting the record system.",
    icon: Building2,
  },
];

export const steps = [
  {
    title: "Configure your internet packages",
    description: "Set the plans, prices, and billing intervals your business actually sells.",
  },
  {
    title: "Register subscribers and their services",
    description: "Add each customer and attach the service that should be billed.",
  },
  {
    title: "Manage billing and payments",
    description: "Issue invoices, record what was paid, and follow what is still open.",
  },
  {
    title: "Review performance and operations",
    description: "Use activity and summary views to see how the business is moving.",
  },
] as const;

export const securityPoints: Feature[] = [
  {
    title: "Role-based access",
    description: "Staff access is intended to follow assigned roles rather than a single shared login.",
    icon: Shield,
  },
  {
    title: "Protected subscriber information",
    description:
      "Customer records are designed to live inside authenticated areas of the product.",
    icon: LockKeyhole,
  },
  {
    title: "Secure API communication",
    description: "Application traffic is planned to travel over encrypted connections.",
    icon: KeyRound,
  },
  {
    title: "Auditable administrative activities",
    description: "Important account changes are intended to leave an activity record.",
    icon: ScrollText,
  },
  {
    title: "Consistent billing records",
    description: "Invoices and payments are designed to stay tied to the subscriber they belong to.",
    icon: Receipt,
  },
  {
    title: "Performance-conscious architecture",
    description:
      "The product is being shaped so everyday screens stay responsive as records grow.",
    icon: Activity,
  },
];

export const faqs = [
  {
    question: "What is ISP CENTRIC?",
    answer:
      "ISP CENTRIC is a software platform for internet providers that want subscriber records, billing, payments, and operational visibility in one product. This public website introduces the product. The billing workspace itself is still in development.",
  },
  {
    question: "Which internet providers can use the platform?",
    answer:
      "It is being designed for fibre providers, wireless ISPs, hotspot operators, neighbourhood networks, and regional internet businesses.",
  },
  {
    question: "Can it support recurring billing?",
    answer:
      "Recurring billing is a core part of the product plan. Packages will define the price and interval, and invoices will be prepared from those settings. That workflow is not live on this website.",
  },
  {
    question: "Can it integrate with network devices?",
    answer:
      "Network and router integration is a planned capability. Device connections are not available in this phase.",
  },
  {
    question: "Can customers manage their accounts?",
    answer:
      "A customer self-service portal is planned so subscribers can review their own account details. It is not part of this public landing page.",
  },
  {
    question: "Can multiple staff members use the platform?",
    answer:
      "You can create an account and sign in with a 6-digit login code and a 6-digit password. New accounts stay pending until they are approved. Only then can that ISP client open their unique account.",
  },
  {
    question: "How can I request a demo?",
    answer:
      "Use Request a Demo in the header or the form on the demo page. The form checks your details in the browser. Delivery to the ISP CENTRIC team is pending a backend endpoint, so a submission is not sent yet.",
  },
] as const;

export const previewSubscribers = [
  { name: "Amina Okello", packageName: "Fibre 50", status: "Active", balance: "$0.00" },
  { name: "James Otieno", packageName: "Wireless 20", status: "Active", balance: "$24.00" },
  { name: "Lydia Mwangi", packageName: "Fibre 100", status: "Due", balance: "$61.00" },
  { name: "Peter Kamau", packageName: "Hotspot Plus", status: "Paused", balance: "$0.00" },
] as const;

export const chartPoints = [42, 48, 51, 57, 63, 71] as const;
export const chartLabels = ["May", "Jun", "Jul", "Aug", "Sep", "Oct"] as const;
