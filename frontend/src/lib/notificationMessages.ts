import type { NotificationEventItem } from "@/components/notifications/NotificationEventList";

export type IspMeNotificationKey =
  | "mikrotikOnboarded"
  | "mikrotikUnreachable"
  | "mikrotikNoInternet"
  | "clientCannotSurf"
  | "subscriptionEnding"
  | "communicationsFailed"
  | "paymentsFailed"
  | "serverUnreachable";

export type IspClientNotificationKey =
  | "subscriptionEnding"
  | "subscriptionExpired"
  | "paymentReceived"
  | "accountActivated"
  | "accountPaused"
  | "maintenance";

export type IspHotspotNotificationKey =
  | "sessionEnding"
  | "sessionExpired"
  | "paymentReceived"
  | "voucherActivated"
  | "maintenance";

export type CompanyNotificationKey =
  | "serverUnreachable"
  | "mikrotikUnreachable"
  | "mikrotikAdded"
  | "ispRegistered"
  | "systemPerformance"
  | "communicationsFailed"
  | "paymentsFailed";

export const meNotificationEvents: NotificationEventItem<IspMeNotificationKey>[] = [
  {
    key: "mikrotikOnboarded",
    label: "A MikroTik is successfully onboarded",
    detail: "Alert when a router finishes onboarding and comes under management.",
    channel: "push",
    placeholders: ["router", "site"],
    defaultMessage: "Router {router} at {site} was onboarded and is under management.",
  },
  {
    key: "mikrotikUnreachable",
    label: "The system cannot communicate with a MikroTik",
    detail: "Alert when a router fails health checks or disconnects.",
    channel: "push",
    placeholders: ["router", "reason"],
    defaultMessage: "{router} is unreachable: {reason}.",
  },
  {
    key: "mikrotikNoInternet",
    label: "There is no internet on a MikroTik",
    detail: "Alert when a router is reachable but its uplinks have no internet.",
    channel: "push",
    placeholders: ["router"],
    defaultMessage: "{router} is online but has no internet on its uplinks.",
  },
  {
    key: "clientCannotSurf",
    label: "A client cannot surf",
    detail: "Alert when a subscriber is connected but cannot reach the internet.",
    channel: "push",
    placeholders: ["name", "router"],
    defaultMessage: "{name} on {router} is connected but cannot surf.",
  },
  {
    key: "subscriptionEnding",
    label: "A client subscription is ending",
    detail: "Alert a day before a PPPoE subscription expires.",
    channel: "push",
    placeholders: ["name", "package", "expiry"],
    defaultMessage: "{name}'s {package} package ends on {expiry}.",
  },
  {
    key: "communicationsFailed",
    label: "The communications API fails",
    detail: "Alert when the SMS, WhatsApp, or email API in use stops working.",
    channel: "push",
    defaultMessage: "The communications API for this account stopped working. Check Communications settings.",
  },
  {
    key: "paymentsFailed",
    label: "The payments API fails",
    detail: "Alert when the payment API in use stops working.",
    channel: "push",
    defaultMessage: "The payments API for this account stopped working. Check payment settings.",
  },
  {
    key: "serverUnreachable",
    label: "The app cannot communicate with the servers",
    detail: "Alert when this portal loses contact with the account service.",
    channel: "push",
    defaultMessage: "This portal lost contact with the account service. Check connectivity and try again.",
  },
];

export const clientNotificationEvents: NotificationEventItem<IspClientNotificationKey>[] = [
  {
    key: "subscriptionEnding",
    label: "Their subscription is ending",
    detail: "Message the PPPoE subscriber a day before their package expires, with a payment link.",
    channel: "sms",
    placeholders: ["name", "package", "expiry", "link", "amount"],
    defaultMessage:
      "Hi {name}, your {package} subscription ends on {expiry}. Pay now to renew before service stops: {link}",
  },
  {
    key: "subscriptionExpired",
    label: "Their subscription has expired",
    detail: "Message the PPPoE subscriber when their package ends, with a payment link to reconnect.",
    channel: "sms",
    placeholders: ["name", "package", "link", "amount"],
    defaultMessage:
      "Hi {name}, your {package} subscription has expired and service has stopped. Pay here to reconnect: {link}",
  },
  {
    key: "paymentReceived",
    label: "A payment is received",
    detail: "Confirm the payment and renewed expiry after a successful top-up.",
    channel: "sms",
    placeholders: ["name", "amount", "package", "expiry"],
    defaultMessage:
      "Hi {name}, payment of KSh {amount} received. Your {package} package is active until {expiry}.",
  },
  {
    key: "accountActivated",
    label: "Their account is activated",
    detail: "Welcome the PPPoE subscriber when a new account or package starts.",
    channel: "sms",
    placeholders: ["name", "package", "expiry"],
    defaultMessage: "Welcome {name}. Your {package} account is now active until {expiry}.",
  },
  {
    key: "accountPaused",
    label: "Their account is paused",
    detail: "Tell the PPPoE subscriber when their line is paused or restricted.",
    channel: "sms",
    placeholders: ["name"],
    defaultMessage: "Hi {name}, your internet account has been paused. Contact support if you need it restored.",
  },
  {
    key: "maintenance",
    label: "There is maintenance (cannot surf)",
    detail: "Message affected PPPoE subscribers when maintenance puts their line in a cannot-surf state.",
    channel: "sms",
    placeholders: ["name", "router"],
    defaultMessage:
      "Hi {name}, maintenance is affecting service on {router}. Surfing may be unavailable until work is finished.",
  },
];

export const hotspotNotificationEvents: NotificationEventItem<IspHotspotNotificationKey>[] = [
  {
    key: "sessionEnding",
    label: "Their hotspot session is ending",
    detail: "Message the guest before their voucher time runs out.",
    channel: "sms",
    placeholders: ["name", "expiry"],
    defaultMessage: "Hi {name}, your hotspot session ends at {expiry}. Buy more time to stay online.",
  },
  {
    key: "sessionExpired",
    label: "Their hotspot session has expired",
    detail: "Message the guest when voucher time ends and surfing stops.",
    channel: "sms",
    placeholders: ["name"],
    defaultMessage: "Hi {name}, your hotspot session has expired. Purchase a new voucher to reconnect.",
  },
  {
    key: "paymentReceived",
    label: "A hotspot payment is received",
    detail: "Confirm the payment by SMS and include the voucher code(s) for the paid device slots.",
    channel: "sms",
    placeholders: ["package", "amount", "voucher", "vouchers"],
    defaultMessage:
      "Payment received for {package} (KSh {amount}). Voucher: {voucher}. Enter a voucher under Have a voucher? to connect.",
  },
  {
    key: "voucherActivated",
    label: "Their voucher is activated",
    detail: "Tell the guest when a voucher is redeemed and surfing starts.",
    channel: "sms",
    placeholders: ["name", "voucher", "package", "expiry"],
    defaultMessage: "Hi {name}, voucher {voucher} for {package} is active until {expiry}. Enjoy your session.",
  },
  {
    key: "maintenance",
    label: "There is maintenance (cannot surf)",
    detail: "Message affected hotspot guests when maintenance puts their session in a cannot-surf state.",
    channel: "sms",
    placeholders: ["name", "router"],
    defaultMessage:
      "Hi {name}, maintenance is affecting hotspot service on {router}. Surfing may be unavailable until work is finished.",
  },
];

export const companyNotificationEvents: NotificationEventItem<CompanyNotificationKey>[] = [
  {
    key: "systemPerformance",
    label: "System performance needs attention",
    detail: "Alert when host CPU, memory, disk, or uplink crosses a high threshold.",
    channel: "push",
    placeholders: ["metric", "percent"],
    defaultMessage: "Host {metric} is at {percent}% — check System performance.",
  },
  {
    key: "ispRegistered",
    label: "A new ISP client is registered",
    detail: "Alert when a new ISP signs up and is waiting for review.",
    channel: "push",
    placeholders: ["isp"],
    defaultMessage: "New ISP client {isp} registered and is waiting for review.",
  },
  {
    key: "mikrotikAdded",
    label: "A MikroTik is onboarded",
    detail: "Alert when an ISP client onboards a new router.",
    channel: "push",
    placeholders: ["router", "isp", "site"],
    defaultMessage: "{isp} onboarded router {router} at {site}.",
  },
  {
    key: "serverUnreachable",
    label: "The app cannot communicate with the servers",
    detail: "Alert when this portal loses contact with the account service.",
    channel: "push",
    defaultMessage: "The company portal lost contact with the account service.",
  },
  {
    key: "mikrotikUnreachable",
    label: "The app cannot communicate with MikroTiks",
    detail: "Alert when a managed router stops answering health checks.",
    channel: "push",
    placeholders: ["router", "isp", "reason"],
    defaultMessage: "{router} ({isp}) is unreachable: {reason}.",
  },
  {
    key: "communicationsFailed",
    label: "The communications API fails",
    detail: "Alert when the company SMS, WhatsApp, or email gateway stops working.",
    channel: "push",
    defaultMessage: "The company communications API stopped working. Check company Communications settings.",
  },
  {
    key: "paymentsFailed",
    label: "The payments APIs fail",
    detail: "Alert when the company payment gateway or Daraja credentials stop working.",
    channel: "push",
    defaultMessage: "The company payments API stopped working. Check company payment settings.",
  },
];
