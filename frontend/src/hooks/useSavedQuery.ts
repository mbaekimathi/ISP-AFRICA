import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/api";

type SavedState<T> = {
  data: T | null;
  error: string;
  loading: boolean;
};

export function useSavedQuery<T>(path: string | null): SavedState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(Boolean(path));

  useEffect(() => {
    if (!path) return;
    let stopped = false;
    let timer = 0;
    let delay = 15000;
    let controller = new AbortController();

    const load = () => {
      controller.abort();
      controller = new AbortController();
      apiRequest<T>(path, { signal: controller.signal })
        .then((body) => {
          if (stopped) return;
          delay = 15000;
          setData(body);
          setError("");
          setLoading(false);
          timer = window.setTimeout(load, delay);
        })
        .catch((cause: unknown) => {
          if (stopped || (cause instanceof DOMException && cause.name === "AbortError")) return;
          setLoading(false);
          setError(cause instanceof Error ? cause.message : "Saved data could not be loaded.");
          delay = Math.min(delay * 2, 60000);
          timer = window.setTimeout(load, delay);
        });
    };

    load();
    return () => {
      stopped = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [path]);

  return { data, error, loading };
}
