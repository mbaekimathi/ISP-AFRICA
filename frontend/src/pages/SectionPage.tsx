import { PageHeader } from "@/components/ui/DetailGrid";
import { usePageMeta } from "@/hooks/usePageMeta";

export function SectionPage({ title }: { title: string }) {
  usePageMeta(`${title} — ISP CENTRIC`, `${title} in ISP CENTRIC.`);

  return (
    <div className="page-shell py-8">
      <PageHeader title={title} />
    </div>
  );
}
