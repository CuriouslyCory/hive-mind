// Re-exports every table in the Drizzle schema. drizzle-kit reads this file to
// generate migrations, and `createDb` passes it to Drizzle for relational
// queries. Each module holds one area of the schema.
export * from "./auth.ts";
export * from "./project.ts";
export * from "./project-api-key.ts";
