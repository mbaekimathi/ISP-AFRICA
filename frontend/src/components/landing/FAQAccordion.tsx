import * as Accordion from "@radix-ui/react-accordion";
import { ChevronDown } from "lucide-react";
import { faqs } from "@/content/landing";

export function FAQAccordion() {
  return (
    <Accordion.Root type="single" collapsible className="divide-y divide-border rounded-2xl border border-border bg-surface shadow-card">
      {faqs.map((item, index) => (
        <Accordion.Item key={item.question} value={`faq-${index}`}>
          <Accordion.Header>
            <Accordion.Trigger className="group flex min-h-11 w-full items-center justify-between gap-4 px-5 py-4 text-left text-base font-semibold text-foreground hover:bg-surface-muted">
              {item.question}
              <ChevronDown className="h-4 w-4 shrink-0 transition-transform duration-brand group-data-[state=open]:rotate-180" aria-hidden="true" />
            </Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content className="overflow-hidden px-5 pb-4 text-sm leading-6 text-muted-foreground data-[state=closed]:animate-none">
            {item.answer}
          </Accordion.Content>
        </Accordion.Item>
      ))}
    </Accordion.Root>
  );
}
