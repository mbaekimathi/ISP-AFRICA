export const pendingIntegrations = {
  demoRequest: {
    status: "pending" as const,
    plannedEndpoint: "/api/demo-requests",
    intro:
      "The form checks your details in the browser. Nothing is sent, because the demo request API is not connected yet.",
    message:
      "Your details passed validation, but the request was not sent. The demo request API is not connected yet.",
  },
  authentication: {
    status: "local" as const,
    loginRoute: "/login",
    signUpRoute: "/signup",
    message:
      "Accounts are saved in ISP-DB. Sign-in uses the 6-digit login code and 6-digit password. The unique ISP client account opens when that database record is approved.",
  },
} as const;
