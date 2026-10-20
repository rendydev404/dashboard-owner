import { migrate } from "../migrate";
import { sql } from "../db";
await migrate();
console.log("Migrasi selesai");
await sql.end();
