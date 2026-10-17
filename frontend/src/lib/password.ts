const ITERATIONS = 210_000;

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function deriveBits(password: string, saltHex: string, iterations: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations, hash: "SHA-256" },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function createPasswordHash(password: string, saltHex: string) {
  const digest = await deriveBits(password, saltHex, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${digest}`;
}

export async function verifyPassword(password: string, saltHex: string, storedHash: string) {
  if (storedHash.startsWith("pbkdf2$")) {
    const [, iterationText, digest] = storedHash.split("$");
    const iterations = Number(iterationText);
    if (!digest || !Number.isFinite(iterations) || iterations < 1) return false;
    const computed = await deriveBits(password, saltHex, iterations);
    return safeEqual(computed, digest);
  }

  const data = new TextEncoder().encode(`${saltHex}:${password}`);
  const legacy = await crypto.subtle.digest("SHA-256", data);
  return safeEqual(bytesToHex(new Uint8Array(legacy)), storedHash);
}
