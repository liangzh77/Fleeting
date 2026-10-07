import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCb);
export async function hashPassword(password: string): Promise<string> {
  if (password.length === 0 || password.length > 1024)
    throw new Error("密码不能为空，且不能超过 1024 个字符");
  const salt = randomBytes(16).toString("hex");
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${key.toString("hex")}`;
}
export function validHash(hash: string): boolean {
  return /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(hash);
}
export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  if (!validHash(hash) || password.length === 0 || password.length > 1024)
    return false;
  const [, salt, expected] = hash.split(":");
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return timingSafeEqual(key, Buffer.from(expected, "hex"));
}
export const digest = (s: string): string =>
  createHash("sha256").update(s).digest("hex");
export const token = (): string => randomBytes(32).toString("hex");
