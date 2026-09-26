import { cp, mkdir } from "node:fs/promises";

const migrations = {
	source: new URL("../src/sqlite/migrations/", import.meta.url),
	target: new URL("../dist/sqlite/migrations/", import.meta.url),
};
const searchSchema = {
	source: new URL("../src/search/schema.sql", import.meta.url),
	target: new URL("../dist/search/schema.sql", import.meta.url),
};

await mkdir(migrations.target, { recursive: true });
await cp(migrations.source, migrations.target, { recursive: true });
await mkdir(new URL(".", searchSchema.target), { recursive: true });
await cp(searchSchema.source, searchSchema.target);
