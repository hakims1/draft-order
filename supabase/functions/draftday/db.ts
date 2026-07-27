import postgres from "npm:postgres@3.4.5";

// Transaction-mode pooler URL; prepared statements must be off.
const sql = postgres(Deno.env.get("DATABASE_URL")!, {
  prepare: false,
  max: 4,
  idle_timeout: 20,
});

export default sql;

export function randomToken(bytes = 18): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
