import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";

const N = 32768,
  r = 8,
  p = 3;
const derive = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N, r, p, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt-v1$${N}$${r}$${p}$${salt.toString("hex")}$${key.toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [scheme, cost, block, parallel, salt, expected, extra] =
    encoded.split("$");
  if (
    scheme !== "scrypt-v1" ||
    cost !== String(N) ||
    block !== String(r) ||
    parallel !== String(p) ||
    extra !== undefined ||
    !/^[a-f0-9]{32}$/.test(salt ?? "") ||
    !/^[a-f0-9]{128}$/.test(expected ?? "")
  )
    return false;
  return timingSafeEqual(
    await derive(password, Buffer.from(salt, "hex")),
    Buffer.from(expected, "hex"),
  );
}
export function recoveryHash(code: string) {
  return createHash("sha256")
    .update(code.trim().replaceAll("-", "").toLowerCase())
    .digest("hex");
}
export function recoveryCode() {
  const raw = randomBytes(32).toString("hex");
  const code = raw.match(/.{8}/g)!.join("-");
  return { code, hash: recoveryHash(code) };
}
export function equalHash(a: string, b: string) {
  const left = Buffer.from(a, "hex"),
    right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
