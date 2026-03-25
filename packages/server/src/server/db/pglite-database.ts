import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { runPaseoDbMigrations } from "./migrations.js";
import { paseoDbSchema } from "./schema.js";

export interface PaseoDatabaseHandle {
  client: PGlite;
  db: ReturnType<typeof drizzle<typeof paseoDbSchema>>;
  close(): Promise<void>;
}

export async function openPaseoDatabase(dataDir: string): Promise<PaseoDatabaseHandle> {
  const client = new PGlite(dataDir);
  const db = drizzle(client, { schema: paseoDbSchema });
  await runPaseoDbMigrations(db);
  return {
    client,
    db,
    async close(): Promise<void> {
      await client.close();
    },
  };
}
