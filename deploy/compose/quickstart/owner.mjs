import { createHash, randomBytes } from "node:crypto";

const random = () => randomBytes(32).toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const validPairId = (id) =>
	typeof id === "string" && /^[A-Za-z0-9_-]{43}$/.test(id);
const empty = () => ({ claimed: false, claim: null, sessions: {}, pairs: {} });

/** Serial in-memory repository for protocol tests; production uses row locking. */
export class MemoryOwnerRepository {
	state = empty();
	pending = Promise.resolve();
	async transaction(fn) {
		const next = this.pending.then(() => fn(this.state));
		this.pending = next.catch(() => {});
		return next;
	}
}

/** One row locks all first-run decisions, including concurrent ingress replicas. */
export class PgOwnerRepository {
	constructor(pool) {
		this.pool = pool;
	}
	async init() {
		await this.pool.query(`CREATE SCHEMA IF NOT EXISTS quickstart`);
		await this.pool.query(
			`CREATE TABLE IF NOT EXISTS quickstart.owner (id integer PRIMARY KEY CHECK(id=1),state jsonb NOT NULL)`,
		);
		await this.pool.query(
			`INSERT INTO quickstart.owner VALUES(1,$1) ON CONFLICT DO NOTHING`,
			[empty()],
		);
	}
	async transaction(fn) {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const { rows } = await client.query(
				"SELECT state FROM quickstart.owner WHERE id=1 FOR UPDATE",
			);
			const state = rows[0].state;
			const result = await fn(state);
			await client.query("UPDATE quickstart.owner SET state=$1 WHERE id=1", [
				state,
			]);
			await client.query("COMMIT");
			return result;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}
}

export class OwnerStore {
	constructor(
		repo,
		{ now = Date.now, sessionMs = 180 * 86400000, pairMs = 300000 } = {},
	) {
		this.repo = repo;
		this.now = now;
		this.sessionMs = sessionMs;
		this.pairMs = pairMs;
	}
	async init() {
		await this.repo.init?.();
		return this.repo.transaction((state) => {
			if (state.claimed) return null;
			const code = random();
			state.claim = digest(code);
			return code;
		});
	}
	/** Console-only recovery; deliberately has no HTTP route. */
	async recover() {
		return this.repo.transaction((state) => {
			const code = random();
			Object.assign(state, empty(), { claim: digest(code) });
			return code;
		});
	}
	async claimed() {
		return this.repo.transaction((state) => state.claimed);
	}
	prune(state) {
		for (const [key, expires] of Object.entries(state.sessions))
			if (expires <= this.now()) delete state.sessions[key];
		for (const [key, pair] of Object.entries(state.pairs))
			if (pair.expires <= this.now()) delete state.pairs[key];
	}
	issue(state) {
		this.prune(state);
		if (Object.keys(state.sessions).length >= 100)
			throw new Error("session_limit");
		const token = `umiak_owner_${random()}`;
		state.sessions[digest(token)] = this.now() + this.sessionMs;
		return token;
	}
	async claim(code) {
		return this.repo.transaction((state) => {
			if (
				state.claimed ||
				typeof code !== "string" ||
				state.claim !== digest(code)
			)
				throw new Error("invalid_claim");
			state.claimed = true;
			state.claim = null;
			return this.issue(state);
		});
	}
	async authenticate(token) {
		if (typeof token !== "string" || token.length > 256) return false;
		return this.repo.transaction(
			(state) =>
				state.claimed && (state.sessions[digest(token)] ?? 0) > this.now(),
		);
	}
	async revoke(token) {
		return this.repo.transaction((state) => {
			delete state.sessions[digest(token)];
		});
	}
	async pairStart() {
		return this.repo.transaction((state) => {
			if (!state.claimed) throw new Error("owner_unclaimed");
			this.prune(state);
			if (Object.keys(state.pairs).length >= 50) throw new Error("pair_limit");
			const id = random();
			const secret = random();
			state.pairs[id] = {
				secret: digest(secret),
				approved: false,
				expires: this.now() + this.pairMs,
			};
			return {
				id,
				secret,
				expiresIn: Math.floor(this.pairMs / 1000),
				interval: 2,
			};
		});
	}
	async pairInfo(id) {
		return this.repo.transaction((state) => {
			const pair = validPairId(id) ? state.pairs[id] : undefined;
			if (!pair || pair.expires <= this.now()) throw new Error("invalid_pair");
			return { id, approved: pair.approved };
		});
	}
	async pairApprove(id) {
		return this.repo.transaction((state) => {
			const pair = validPairId(id) ? state.pairs[id] : undefined;
			if (!pair || pair.expires <= this.now()) throw new Error("invalid_pair");
			pair.approved = true;
		});
	}
	async pairPoll(id, secret) {
		return this.repo.transaction((state) => {
			const pair = validPairId(id) ? state.pairs[id] : undefined;
			if (
				!pair ||
				pair.expires <= this.now() ||
				typeof secret !== "string" ||
				pair.secret !== digest(secret)
			)
				throw new Error("invalid_pair");
			if (!pair.approved) return null;
			delete state.pairs[id];
			return this.issue(state);
		});
	}
}
