// Applies the payload schema migrations (S8 §12; the web-migrate job):
//   DATABASE_URL=... PAYLOAD_SECRET=... node packages/payload/src/migrate.ts
// Exit code 0 when every migration is applied, 1 on any error.
import { closeSbxPayload, getSbxPayload } from "./instance.ts";
import { migrateSbxPayload } from "./run-migrations.ts";

async function main(): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL;
	const secret = process.env.PAYLOAD_SECRET;
	if (!databaseUrl) throw new Error("DATABASE_URL is required");
	if (!secret) throw new Error("PAYLOAD_SECRET is required");
	const payload = await getSbxPayload({
		databaseUrl,
		secret,
		operatorGroups: [],
		poolMax: 4,
	});
	try {
		const applied = await migrateSbxPayload(payload);
		console.log(
			applied.length === 0
				? "payload migrations are up to date"
				: `applied payload migrations: ${applied.join(", ")}`,
		);
	} finally {
		await closeSbxPayload(databaseUrl);
	}
}

main().then(
	() => process.exit(0),
	(err: unknown) => {
		console.error(err instanceof Error ? (err.stack ?? err.message) : err);
		process.exit(1);
	},
);
