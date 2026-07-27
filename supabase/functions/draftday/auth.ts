import sql, { randomToken } from "./db.ts";

const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return new Uint8Array(bits);
}

const toHex = (b: Uint8Array) =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (s: string) =>
  new Uint8Array(s.match(/.{2}/g)!.map((x) => parseInt(x, 16)));

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(password, salt);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, , saltHex, hashHex] = stored.split("$");
  const hash = await pbkdf2(password, fromHex(saltHex));
  const expected = fromHex(hashHex);
  if (hash.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash[i] ^ expected[i];
  return diff === 0;
}

const SESSION_DAYS = 30;

export async function createSession(adminId: string): Promise<string> {
  const token = randomToken(24);
  await sql`
    insert into admin_sessions (token, admin_id, expires_at)
    values (${token}, ${adminId}, now() + make_interval(days => ${SESSION_DAYS}))`;
  return token;
}

export async function adminFromSession(token: string | undefined) {
  if (!token) return null;
  const rows = await sql`
    select a.id, a.email from admin_sessions s
    join admins a on a.id = s.admin_id
    where s.token = ${token} and s.expires_at > now()`;
  return rows[0] ?? null;
}

export async function destroySession(token: string) {
  await sql`delete from admin_sessions where token = ${token}`;
}
