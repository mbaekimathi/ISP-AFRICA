import { useEffect } from "react";

const DEFAULT_DESCRIPTION =
  "ISP CENTRIC is a billing and network management platform for fibre providers, wireless ISPs, hotspot operators, and regional internet businesses.";

export function usePageMeta(title: string, description = DEFAULT_DESCRIPTION) {
  useEffect(() => {
    document.title = title;
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute("content", description);

    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) ogTitle.setAttribute("content", title);

    const ogDescription = document.querySelector('meta[property="og:description"]');
    if (ogDescription) ogDescription.setAttribute("content", description);
  }, [title, description]);
}
