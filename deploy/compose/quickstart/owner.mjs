import { createHash, randomBytes } from "node:crypto";

const random = () => randomBytes(32).toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const validPairId = (id) =>
	typeof id === "string" && /^[A-Za-z0-9_-]{43}$/.test(id);
const sourceMaps = new WeakMap();
const limited = (seconds = 600) =>
	Object.assign(Error("signin_limited"), { retryAfter: Math.max(1, seconds) });
const empty = () => ({
	claimed: false,
	claim: null,
	sessions: {},
	pairs: {},
	signins: {},
});

/** Serial in-memory repository for protocol tests; production uses row locking. */
export class MemoryOwnerRepository {
	state = empty();
	pending = Promise.resolve();
	async read(fn) {
		return fn(this.state);
	}
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
	async read(fn) {
		const { rows } = await this.pool.query(
			"SELECT state FROM quickstart.owner WHERE id=1",
		);
		return fn(rows[0].state);
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
		{
			now = Date.now,
			sessionMs = 180 * 86400000,
			pairMs = 300000,
			audit = (event) => console.info(JSON.stringify(event)),
		} = {},
	) {
		this.repo = repo;
		if (!sourceMaps.has(repo)) sourceMaps.set(repo, new Map());
		this.signinSources = sourceMaps.get(repo);
		this.audit = audit;
		this.now = now;
		this.sessionMs = sessionMs;
		this.pairMs = pairMs;
	}
	async init() {
		await this.repo.init?.();
		return this.repo.transaction((state) => {
			this.pruneSignin(state);
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
	async signinCode({
		source = "console",
		hostname = "unknown",
		issuer = "console",
	} = {}) {
		return this.repo.transaction((state) => {
			if (!state.claimed) throw Error("owner_unclaimed");
			this.pruneSignin(state);
			if (Object.keys(state.signins).length >= 10)
				throw limited(
					Math.ceil(
						(Math.min(...Object.values(state.signins).map((x) => x.expires)) -
							this.now()) /
							1000,
					),
				);
			const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
			const raw = [...randomBytes(24)].map((x) => alphabet[x & 31]).join("");
			const expires = this.now() + 600000;
			state.signins[digest(raw)] = { expires, failures: 0, issuer };
			this.audit({ event: "owner_signin_issued", source, hostname, issuer });
			return { code: raw.match(/.{4}/g).join("-"), expires };
		});
	}
	pruneSignin(state) {
		state.signins ??= {};
		delete state.signinSources; // Discard legacy durable buckets on the next mutation.
		for (const [key, value] of Object.entries(state.signins))
			if (value.expires <= this.now()) delete state.signins[key];
	}
	async signin(code, source, hostname = "unknown") {
		// Map insertion order matches expiry order: prune only the expired prefix.
		for (const [key, bucket] of this.signinSources) {
			if (bucket.expires > this.now()) break;
			this.signinSources.delete(key);
		}
		const key = digest(String(source));
		let bucket = this.signinSources.get(key);
		if (bucket?.count >= 20 || (!bucket && this.signinSources.size >= 10000))
			throw limited(
				Math.ceil(
					((bucket ?? this.signinSources.values().next().value).expires -
						this.now()) /
						1000,
				),
			);
		if (!bucket) {
			bucket = { count: 0, expires: this.now() + 600000 };
			this.signinSources.set(key, bucket);
		}
		bucket.count++;
		// Failed global counters must commit even when the attempt is rejected.
		const result = await this.repo.transaction((state) => {
			this.pruneSignin(state);
			const normalized =
				typeof code === "string"
					? code.toUpperCase().replace(/[-\s]/g, "")
					: "";
			const id = digest(normalized);
			if (state.claimed && state.signins[id]) {
				const token = this.issue(state, "browser", hostname);
				const issuer = state.signins[id].issuer ?? "console";
				delete state.signins[id];
				this.audit({ event: "owner_signin_used", source, hostname, issuer });
				return { token };
			}
			// Unknown guesses count against every live code, preventing distributed guessing.
			for (const [id, item] of Object.entries(state.signins))
				if (++item.failures >= 20) delete state.signins[id];
			return { error: "invalid_signin" };
		});
		if (result.error) throw Error(result.error);
		return result.token;
	}
	async touch(token) {
		const current = await this.session(token);
		if (!current || this.now() - (current.lastUsed ?? 0) < 60000) return;
		return this.repo.transaction((state) => {
			const session = state.sessions[digest(token)];
			if (
				session &&
				typeof session === "object" &&
				session.expires > this.now() &&
				this.now() - (session.lastUsed ?? 0) >= 60000
			)
				session.lastUsed = this.now();
		});
	}

	async claimed() {
		return this.repo.read((state) => state.claimed);
	}
	prune(state) {
		for (const [key, session] of Object.entries(state.sessions))
			if (typeof session === "number" || session.expires <= this.now())
				delete state.sessions[key];
		for (const [key, pair] of Object.entries(state.pairs))
			if (pair.expires <= this.now()) delete state.pairs[key];
	}
	issue(state, kind = "browser", hostname = "unknown") {
		this.prune(state);
		if (Object.keys(state.sessions).length >= 100)
			throw new Error("session_limit");
		const token = `umiak_owner_${random()}`;
		state.sessions[digest(token)] = {
			kind,
			hostname,
			lastUsed: this.now(),
			created: this.now(),
			expires:
				this.now() +
				(kind === "cli"
					? Math.min(this.sessionMs, 30 * 86400000)
					: this.sessionMs),
		};
		return token;
	}
	async claim(code, hostname) {
		return this.repo.transaction((state) => {
			if (
				state.claimed ||
				typeof code !== "string" ||
				state.claim !== digest(code)
			)
				throw new Error("invalid_claim");
			state.claimed = true;
			state.claim = null;
			return this.issue(state, "browser", hostname);
		});
	}
	async session(token) {
		if (typeof token !== "string" || token.length > 256) return null;
		return this.repo.read((state) => {
			const raw = state.sessions[digest(token)];
			const value = typeof raw === "number" ? null : raw;
			return state.claimed && value?.expires > this.now() ? value : null;
		});
	}
	async authenticate(token) {
		return !!(await this.session(token));
	}
	async canApprove(token) {
		return (await this.session(token))?.kind === "browser";
	}
	async sessions(token) {
		return this.repo.read((state) =>
			Object.entries(state.sessions)
				.map(([id, raw]) => ({
					id,
					current: typeof token === "string" && id === digest(token),
					...(typeof raw === "number"
						? { expires: raw, kind: "browser" }
						: raw),
				}))
				.filter((x) => x.expires > this.now()),
		);
	}
	async revokeSession(id) {
		if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
			throw new Error("invalid_session");
		return this.repo.transaction((state) => {
			delete state.sessions[id];
		});
	}
	async revoke(token) {
		return this.repo.transaction((state) => {
			delete state.sessions[digest(token)];
		});
	}
	async pairStart({
		source = "unknown",
		userAgent = "unknown",
		hostname = "unknown",
	} = {}) {
		return this.repo.transaction((state) => {
			if (!state.claimed) throw new Error("owner_unclaimed");
			this.prune(state);
			if (
				Object.values(state.pairs).filter((pair) => pair.source === source)
					.length >= 5 ||
				Object.keys(state.pairs).length >= 1000
			)
				throw new Error("pair_limit");
			const id = random();
			const secret = random();
			state.pairs[id] = {
				secret: digest(secret),
				code: randomBytes(4)
					.toString("hex")
					.toUpperCase()
					.replace(/(.{4})(.{4})/, "$1-$2"),
				source,
				hostname,
				userAgent: String(userAgent).slice(0, 256),
				created: this.now(),
				approved: false,
				expires: this.now() + this.pairMs,
			};
			return {
				id,
				code: state.pairs[id].code,
				secret,
				expiresIn: Math.floor(this.pairMs / 1000),
				interval: 2,
			};
		});
	}
	async pairInfo(id) {
		return this.repo.read((state) => {
			const pair = validPairId(id) ? state.pairs[id] : undefined;
			if (!pair || pair.expires <= this.now()) throw new Error("invalid_pair");
			return {
				id,
				approved: pair.approved,
				source: pair.source,
				hostname: pair.hostname,
				userAgent: pair.userAgent,
				created: pair.created,
			};
		});
	}
	async pairApprove(id, code) {
		return this.repo.transaction((state) => {
			const pair = validPairId(id) ? state.pairs[id] : undefined;
			if (!pair || pair.expires <= this.now()) throw new Error("invalid_pair");
			if (typeof code !== "string" || code.toUpperCase() !== pair.code)
				throw new Error("invalid_pair");
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
			return this.issue(state, "cli", pair.hostname);
		});
	}
}
