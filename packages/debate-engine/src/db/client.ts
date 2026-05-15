import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

let cachedDb: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (cachedDb) {
    return cachedDb;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to use the Postgres repository.");
  }

  const client = postgres(connectionString, {
    max: 10,
    prepare: false
  });

  cachedDb = drizzle(client, {
    schema
  });

  return cachedDb;
}
