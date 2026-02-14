import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: ["./src/schema.ts", "./src/plugins/tiger-research.ts"],
  out: "./src/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://opentiger:opentiger@localhost:5432/opentiger",
  },
});
