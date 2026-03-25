import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./packages/server/src/server/db/schema.ts",
  out: "./packages/server/src/server/db/migrations",
  dialect: "postgresql",
  strict: true,
  verbose: true,
});
