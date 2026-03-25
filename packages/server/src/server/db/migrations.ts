import { fileURLToPath } from "node:url";

import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

export async function runPaseoDbMigrations(db: PgliteDatabase<typeof import("./schema.js").paseoDbSchema>): Promise<void> {
  await migrate(db, { migrationsFolder });
}

