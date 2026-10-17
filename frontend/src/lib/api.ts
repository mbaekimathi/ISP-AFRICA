const PLACEHOLDER_PHOTO =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e7eef8"/><circle cx="128" cy="104" r="40" fill="#64748b"/><ellipse cx="128" cy="210" rx="68" ry="46" fill="#64748b"/></svg>',
  );

export class ApiRequestError extends Error {
  errors: { field: string; message: string }[];

  constructor(message: string, errors: { field: string; message: string }[] = []) {
    super(message);
    this.name = "ApiRequestError";
    this.errors = errors;
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    errors?: { field: string; message: string }[];
  };
  if (!response.ok) {
    throw new ApiRequestError(body.error || "The account service could not complete that request.", body.errors ?? []);
  }
  return body;
}

export function withProfilePhoto<T extends { photoDataUrl: string }>(record: T): T {
  return record.photoDataUrl ? record : { ...record, photoDataUrl: PLACEHOLDER_PHOTO };
}
