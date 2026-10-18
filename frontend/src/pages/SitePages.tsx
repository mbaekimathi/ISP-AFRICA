import type { FormEvent } from "react";
import { useState } from "react";
import { FormField } from "@/components/ui/FormField";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Buttons";
import { usePageMeta } from "@/hooks/usePageMeta";
import { pendingIntegrations } from "@/lib/integrations";

type FormState = {
  name: string;
  organization: string;
  email: string;
  message: string;
};

type FieldName = keyof FormState;

const emptyForm: FormState = {
  name: "",
  organization: "",
  email: "",
  message: "",
};

function validate(values: FormState) {
  const errors: Partial<Record<FieldName, string>> = {};
  if (values.name.trim().length < 2) errors.name = "Enter your name.";
  if (values.organization.trim().length < 2) errors.organization = "Enter the organization name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) {
    errors.email = "Enter a valid email address.";
  }
  if (values.message.trim().length > 1000) {
    errors.message = "Keep the message under 1,000 characters.";
  }
  return errors;
}

export function DemoPage() {
  usePageMeta(
    "Request a Demo — ISP CENTRIC",
    "Request a demo of ISP CENTRIC. The form validates in the browser. Delivery is pending a backend endpoint.",
  );
  const [values, setValues] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [pendingNotice, setPendingNotice] = useState("");

  function update(field: FieldName, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setPendingNotice("");
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validate(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setPendingNotice("");
      return;
    }
    setPendingNotice(pendingIntegrations.demoRequest.message);
  }

  return (
    <div className="page-shell py-14 sm:py-20">
      <div className="form-card">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Demo</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Request a demo</h1>
          <p className="mt-4 text-base leading-7 text-muted-foreground">
            Tell us who you are and which kind of network you operate. {pendingIntegrations.demoRequest.intro}
          </p>
        </div>
        <form className="grid gap-4" onSubmit={onSubmit} noValidate>
          <FormField id="name" label="Name" error={errors.name}>
            <input
              id="name"
              name="name"
              className="field"
              autoComplete="name"
              value={values.name}
              aria-invalid={Boolean(errors.name)}
              aria-describedby={errors.name ? "name-error" : undefined}
              onChange={(event) => update("name", event.target.value)}
            />
          </FormField>
          <FormField id="organization" label="Organization" error={errors.organization}>
            <input
              id="organization"
              name="organization"
              className="field"
              autoComplete="organization"
              value={values.organization}
              aria-invalid={Boolean(errors.organization)}
              aria-describedby={errors.organization ? "organization-error" : undefined}
              onChange={(event) => update("organization", event.target.value)}
            />
          </FormField>
          <FormField id="email" label="Email" error={errors.email}>
            <input
              id="email"
              name="email"
              type="email"
              className="field"
              autoComplete="email"
              value={values.email}
              aria-invalid={Boolean(errors.email)}
              aria-describedby={errors.email ? "email-error" : undefined}
              onChange={(event) => update("email", event.target.value)}
            />
          </FormField>
          <FormField id="message" label="What should we know?" hint="Optional. Include the kind of network you run." error={errors.message}>
            <textarea
              id="message"
              name="message"
              className="field"
              value={values.message}
              aria-invalid={Boolean(errors.message)}
              aria-describedby={errors.message ? "message-error" : "message-hint"}
              onChange={(event) => update("message", event.target.value)}
            />
          </FormField>
          {pendingNotice ? (
            <p className="notice" role="status">
              {pendingNotice} Planned endpoint: {pendingIntegrations.demoRequest.plannedEndpoint}.
            </p>
          ) : null}
          <div className="flex flex-col gap-3 sm:flex-row">
            <PrimaryButton type="submit">Check demo request</PrimaryButton>
            <SecondaryButton to="/">Back to home</SecondaryButton>
          </div>
        </form>
      </div>
    </div>
  );
}

export function PrivacyPage() {
  usePageMeta(
    "Privacy Policy — ISP CENTRIC",
    "The ISP CENTRIC privacy policy has not been published yet.",
  );

  return (
    <article className="page-shell py-16">
      <div className="legal-prose">
        <h1>Privacy Policy</h1>
        <p>
          A privacy policy will be published before ISP CENTRIC collects customer or subscriber information. This landing page does not send form data to a server.
        </p>
        <p>
          Demo request details stay in your browser for validation only and are discarded when you leave or refresh the page.
        </p>
      </div>
    </article>
  );
}

export function TermsPage() {
  usePageMeta(
    "Terms of Service — ISP CENTRIC",
    "The ISP CENTRIC terms of service have not been published yet.",
  );

  return (
    <article className="page-shell py-16">
      <div className="legal-prose">
        <h1>Terms of Service</h1>
        <p>
          Terms of service will be published before the billing platform is offered for use. This website is a product introduction, not a service agreement.
        </p>
      </div>
    </article>
  );
}
