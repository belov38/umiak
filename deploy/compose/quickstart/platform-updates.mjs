// Declarative owner policy only. Root operations belong exclusively to the host.
export function validateUpdateSettings(input) {
	const defaults = {
		channel: "stable",
		auto: false,
		paused: false,
		start: "03:00",
		end: "04:00",
	};
	if (
		!input ||
		typeof input !== "object" ||
		Array.isArray(input) ||
		Object.keys(input).some((key) => !(key in defaults))
	)
		throw Error("Invalid update settings");
	const value = { ...defaults, ...input };
	if (
		!["stable", "edge"].includes(value.channel) ||
		["auto", "paused"].some((key) => typeof value[key] !== "boolean")
	)
		throw Error("Invalid update channel or mode");
	if (
		["start", "end"].some(
			(key) =>
				typeof value[key] !== "string" ||
				!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value[key]),
		) ||
		value.start === value.end
	)
		throw Error("Use a nonzero HH:MM maintenance window in host local time");
	return value;
}

export class PgPlatformUpdates {
	constructor(pool, setupStore) {
		Object.assign(this, { pool, setupStore });
	}
	async init() {
		await this.pool.query(
			`CREATE TABLE IF NOT EXISTS quickstart.updates(id boolean PRIMARY KEY DEFAULT true CHECK(id), settings jsonb NOT NULL, status jsonb NOT NULL DEFAULT '{}', history jsonb NOT NULL DEFAULT '[]')`,
		);
	}
	async read() {
		const row = (
			await this.pool.query(
				"SELECT settings,status,history FROM quickstart.updates WHERE id=true",
			)
		).rows[0];
		if (row) return row;
		const state = await this.setupStore.read();
		return {
			settings: validateUpdateSettings({
				channel: state.platform?.channel || "stable",
			}),
			status: {},
			history: [],
		};
	}
	async write(input) {
		const settings = validateUpdateSettings(input);
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(
				"SELECT pg_advisory_xact_lock(hashtextextended('umiak-quickstart:setup',0))",
			);
			await client.query(
				`UPDATE quickstart.setup SET state=jsonb_set(state,'{platform}',COALESCE(state->'platform','{}') || $1::jsonb) WHERE id=true`,
				[JSON.stringify({ channel: settings.channel })],
			);
			await client.query(
				`INSERT INTO quickstart.updates(id,settings) VALUES(true,$1) ON CONFLICT(id) DO UPDATE SET settings=EXCLUDED.settings`,
				[JSON.stringify(settings)],
			);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}
}
