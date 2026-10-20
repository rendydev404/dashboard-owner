// Pemakaian: pnpm user:create <email> <nama> <owner|admin>   (password dibaca dari env USER_PASSWORD atau prompt)
import { createInterface } from "node:readline/promises";
import { sql } from "../db";
import { hashPassword } from "../auth";

const [email, name, role = "owner"] = process.argv.slice(2);
if (!email || !name || !["owner", "admin"].includes(role)) {
  console.error("Pemakaian: user:create <email> <nama> <owner|admin>");
  process.exit(1);
}
let password = process.env.USER_PASSWORD;
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question("Password (min. 10 karakter): ");
  rl.close();
}
if (!password || password.length < 10) {
  console.error("Password minimal 10 karakter");
  process.exit(1);
}
await sql`
  INSERT INTO users (email, name, role, password_hash) VALUES (${email.toLowerCase()}, ${name}, ${role}, ${await hashPassword(password)})
  ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, password_hash = EXCLUDED.password_hash`;
console.log(`User ${email} (${role}) siap.`);
await sql.end();
