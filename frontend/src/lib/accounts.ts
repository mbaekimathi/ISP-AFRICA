import { apiRequest, withProfilePhoto } from "@/lib/api";

export type AccountInput = {
  firstName: string;
  lastName: string;
  username: string;
  email: string;
  phone: string;
  loginCode: string;
  password: string;
  photoDataUrl: string;
};

export type AccountStatus = "pending" | "approved";

export type PublicAccount = {
  id: string;
  firstName: string;
  lastName: string;
  username: string;
  email: string;
  phone: string;
  loginCode: string;
  photoDataUrl: string;
  status: AccountStatus;
  clientCode: string | null;
  dashboardCode: string | null;
};

export function clientPage(account: Pick<PublicAccount, "dashboardCode">, path: string) {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return account.dashboardCode ? `/${account.dashboardCode}${suffix}` : suffix;
}

export function clientHomePath(account: Pick<PublicAccount, "dashboardCode">) {
  return clientPage(account, "/dashboard");
}

export async function readSession(): Promise<PublicAccount | null> {
  try {
    const body = await apiRequest<{ account: PublicAccount | null }>("/api/client/session");
    return body.account ? withProfilePhoto(body.account) : null;
  } catch {
    return null;
  }
}

export async function registerAccount(input: AccountInput): Promise<PublicAccount> {
  const body = await apiRequest<{ account: PublicAccount }>("/api/client/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return withProfilePhoto(body.account);
}

export async function loginWithCode(loginCode: string, password: string): Promise<PublicAccount> {
  const body = await apiRequest<{ account: PublicAccount }>("/api/client/login", {
    method: "POST",
    body: JSON.stringify({ loginCode, password }),
  });
  return withProfilePhoto(body.account);
}

export async function listAccountsForReview(): Promise<PublicAccount[]> {
  const body = await apiRequest<{ accounts: PublicAccount[] }>("/api/client/reviews");
  return body.accounts.map(withProfilePhoto);
}

export async function approveAccount(id: string): Promise<PublicAccount> {
  const body = await apiRequest<{ account: PublicAccount }>("/api/client/approve", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
  return withProfilePhoto(body.account);
}

export async function logoutAccount() {
  await apiRequest("/api/client/logout", { method: "POST", body: "{}" });
}

export async function enterClientPortal(id: string): Promise<PublicAccount> {
  const body = await apiRequest<{ account: PublicAccount }>("/api/director/clients/enter", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
  return withProfilePhoto(body.account);
}

export function fileToPackageImage(file: File) {
  return new Promise<string>((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("Choose an image file."));
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      reject(new Error("Choose an image smaller than 8 MB."));
      return;
    }
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      const width = 640;
      const height = 360;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        URL.revokeObjectURL(url);
        reject(new Error("Could not read that image."));
        return;
      }
      const scale = Math.max(width / image.width, height / image.height);
      const drawnWidth = image.width * scale;
      const drawnHeight = image.height * scale;
      context.drawImage(image, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight);
      URL.revokeObjectURL(url);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
      if (dataUrl.length > 200_000) {
        reject(new Error("Choose a simpler image. That one is too large to save."));
        return;
      }
      resolve(dataUrl);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that image."));
    };
    image.src = url;
  });
}

export function fileToProfilePhoto(file: File) {
  return new Promise<string>((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("Choose an image file."));
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      reject(new Error("Choose an image smaller than 8 MB."));
      return;
    }

    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      const size = 256;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      if (!context) {
        URL.revokeObjectURL(url);
        reject(new Error("Could not read that image."));
        return;
      }
      const scale = Math.max(size / image.width, size / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that image."));
    };
    image.src = url;
  });
}
