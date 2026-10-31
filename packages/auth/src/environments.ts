import type pg from "pg";
import { IdentityError } from "./identity.ts";
import { inTx, pgCode, UNIQUE_VIOLATION } from "./pg-util.ts";
import {
	applySecretPatch,
	type SecretFile,
	type SecretPatch,
	type SecretSets,
} from "./secret-sets.ts";

// Environments of a team (S8 §10) in table runtime.environments (migration
// 0400). The table has no foreign keys: teams and users live in the Payload
// schema, so the caller (apps/api) resolves the team before it calls the
// store. The sets are encrypted with the data key ring, AAD
// `environment:<id>:v<keyVersion>` (S8 §10.3).
// Limits and names are validated by the caller (apps/api); the store merges,
// encrypts and persists.

/**
 * The part of KeyRing (@sbx/core) the store needs. auth cannot import core
 * (core depends on auth); a KeyRing instance satisfies this structurally.
 */
export interface EnvironmentKeys {
	encryptFor(
		aadPrefix: string,
		id: string,
		plaintext: string,
	): { keyVersion: number; nonce: Uint8Array; ciphertext: Uint8Array };
	decryptFor(
		aadPrefix: string,
		id: string,
		blob: { keyVersion: number; nonce: Uint8Array; ciphertext: Uint8Array },
	): Uint8Array;
}

/** Stored only in the MVP; cloned by S13 (S8 §10.1). */
export interface EnvironmentRepository {
	url: string;
	branch?: string;
	path?: string;
}

export interface EnvironmentRecord {
	id: string;
	teamId: string;
	name: string;
	isDefault: boolean;
	/** 1 on create, +1 on every patch. */
	revision: number;
	sets: SecretSets;
	repositories: EnvironmentRepository[];
	excludeOwnerSecrets: boolean;
	createdAt: Date;
	updatedAt: Date;
	updatedBy: string | null;
}

/** Body of `POST /v1/environments` (S8 §10.2). */
export interface NewEnvironment {
	name: string;
	isDefault?: boolean;
	env?: Record<string, string>;
	secrets?: Record<string, string>;
	secretFiles?: SecretFile[];
	repositories?: EnvironmentRepository[];
	excludeOwnerSecrets?: boolean;
}

/**
 * Body of `PATCH /v1/environments/{environment}`: sets merge by key
 * (`applySecretPatch`: `null` deletes, files match by name and are replaced
 * whole), repositories are replaced.
 */
export interface EnvironmentPatch extends SecretPatch {
	name?: string;
	isDefault?: boolean;
	repositories?: EnvironmentRepository[];
	excludeOwnerSecrets?: boolean;
}

export interface EnvironmentStore {
	/** Environments of the team, by name. */
	list(teamId: string): Promise<EnvironmentRecord[]>;
	/** By id (uuid) or name, within the team. */
	get(teamId: string, idOrName: string): Promise<EnvironmentRecord | null>;
	getDefault(teamId: string): Promise<EnvironmentRecord | null>;
	/** Throws IdentityError `name_taken`. */
	create(
		teamId: string,
		input: NewEnvironment,
		byUserId: string | null,
	): Promise<EnvironmentRecord>;
	/** Throws IdentityError `not_found` or `name_taken`. */
	patch(
		teamId: string,
		idOrName: string,
		patch: EnvironmentPatch,
		byUserId: string | null,
	): Promise<EnvironmentRecord>;
	/** Throws IdentityError `not_found`. */
	delete(teamId: string, idOrName: string): Promise<void>;
}

export interface PgEnvironmentStoreOptions {
	/**
	 * Called with the sets to be stored (after a patch is merged), inside the
	 * write; throwing aborts it. apps/api passes core's validateSecretSets.
	 */
	validateSets?: (sets: SecretSets) => void;
}

interface EnvRow {
	id: string;
	team_id: string;
	name: string;
	is_default: boolean;
	revision: number;
	key_version: number;
	nonce: Buffer;
	ciphertext: Buffer;
	repositories: EnvironmentRepository[];
	exclude_owner_secrets: boolean;
	created_at: Date;
	updated_at: Date;
	updated_by: string | null;
}

/** AAD prefix of the environment blobs: `environment:<id>:v<keyVersion>`. */
export const ENVIRONMENT_AAD_PREFIX = "environment";

const COLS = `id, team_id, name, is_default, revision, key_version, nonce, ciphertext,
  repositories, exclude_owner_secrets, created_at, updated_at, updated_by`;

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// An id that is a uuid matches by id first; anything else only by name.
const BY_ID_OR_NAME = `team_id = $1 AND (name = $2 OR id = $3::uuid)
  ORDER BY (id IS NOT DISTINCT FROM $3::uuid) DESC LIMIT 1`;

function idParam(idOrName: string): string | null {
	return UUID_RE.test(idOrName) ? idOrName : null;
}

export class PgEnvironmentStore implements EnvironmentStore {
	readonly #pool: pg.Pool;
	readonly #keys: EnvironmentKeys;
	readonly #validate: (sets: SecretSets) => void;

	constructor(
		pool: pg.Pool,
		keys: EnvironmentKeys,
		opts: PgEnvironmentStoreOptions = {},
	) {
		this.#pool = pool;
		this.#keys = keys;
		this.#validate = opts.validateSets ?? (() => {});
	}

	async list(teamId: string): Promise<EnvironmentRecord[]> {
		const r = await this.#pool.query<EnvRow>(
			`SELECT ${COLS} FROM runtime.environments WHERE team_id = $1 ORDER BY name`,
			[teamId],
		);
		return r.rows.map((row) => this.#record(row));
	}

	async get(
		teamId: string,
		idOrName: string,
	): Promise<EnvironmentRecord | null> {
		const r = await this.#pool.query<EnvRow>(
			`SELECT ${COLS} FROM runtime.environments WHERE ${BY_ID_OR_NAME}`,
			[teamId, idOrName, idParam(idOrName)],
		);
		return r.rows[0] ? this.#record(r.rows[0]) : null;
	}

	async getDefault(teamId: string): Promise<EnvironmentRecord | null> {
		const r = await this.#pool.query<EnvRow>(
			`SELECT ${COLS} FROM runtime.environments WHERE team_id = $1 AND is_default`,
			[teamId],
		);
		return r.rows[0] ? this.#record(r.rows[0]) : null;
	}

	async create(
		teamId: string,
		input: NewEnvironment,
		byUserId: string | null,
	): Promise<EnvironmentRecord> {
		// An empty patch copies the sets (files keep only the known fields).
		const sets = applySecretPatch(
			{
				env: input.env ?? {},
				secrets: input.secrets ?? {},
				secretFiles: input.secretFiles ?? [],
			},
			{},
		);
		this.#validate(sets);
		const id = (
			await this.#pool.query<{ id: string }>("SELECT uuidv7()::text AS id")
		).rows[0]?.id as string;
		const blob = this.#encrypt(id, sets);
		return this.#write(teamId, input.isDefault === true, async (c) => {
			const r = await c.query<EnvRow>(
				`INSERT INTO runtime.environments
				   (id, team_id, name, is_default, revision, key_version, nonce, ciphertext,
				    repositories, exclude_owner_secrets, updated_by)
				 VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10)
				 RETURNING ${COLS}`,
				[
					id,
					teamId,
					input.name,
					input.isDefault === true,
					blob.keyVersion,
					blob.nonce,
					blob.ciphertext,
					JSON.stringify(input.repositories ?? []),
					input.excludeOwnerSecrets === true,
					byUserId,
				],
			);
			return r.rows[0] as EnvRow;
		});
	}

	async patch(
		teamId: string,
		idOrName: string,
		patch: EnvironmentPatch,
		byUserId: string | null,
	): Promise<EnvironmentRecord> {
		return this.#write(teamId, patch.isDefault === true, async (c) => {
			const cur = (
				await c.query<EnvRow>(
					`SELECT ${COLS} FROM runtime.environments WHERE ${BY_ID_OR_NAME} FOR UPDATE`,
					[teamId, idOrName, idParam(idOrName)],
				)
			).rows[0];
			if (!cur) throw new IdentityError("not_found");
			const sets = applySecretPatch(this.#record(cur).sets, patch);
			this.#validate(sets);
			const blob = this.#encrypt(cur.id, sets);
			const r = await c.query<EnvRow>(
				`UPDATE runtime.environments SET
				   name = $2, is_default = $3, revision = revision + 1,
				   key_version = $4, nonce = $5, ciphertext = $6,
				   repositories = $7, exclude_owner_secrets = $8,
				   updated_at = now(), updated_by = $9
				 WHERE id = $1
				 RETURNING ${COLS}`,
				[
					cur.id,
					patch.name ?? cur.name,
					patch.isDefault ?? cur.is_default,
					blob.keyVersion,
					blob.nonce,
					blob.ciphertext,
					JSON.stringify(patch.repositories ?? cur.repositories),
					patch.excludeOwnerSecrets ?? cur.exclude_owner_secrets,
					byUserId,
				],
			);
			return r.rows[0] as EnvRow;
		});
	}

	async delete(teamId: string, idOrName: string): Promise<void> {
		const r = await this.#pool.query(
			`DELETE FROM runtime.environments WHERE id = (
			   SELECT id FROM runtime.environments WHERE ${BY_ID_OR_NAME})`,
			[teamId, idOrName, idParam(idOrName)],
		);
		if (!r.rowCount) throw new IdentityError("not_found");
	}

	// Runs a write in a transaction. A write that makes an environment the
	// default first takes the team lock and clears the current default, so
	// concurrent "make default" requests serialize instead of hitting the
	// partial unique index.
	async #write(
		teamId: string,
		makeDefault: boolean,
		fn: (c: pg.PoolClient) => Promise<EnvRow>,
	): Promise<EnvironmentRecord> {
		try {
			const row = await inTx(this.#pool, async (c) => {
				if (makeDefault) {
					await c.query(
						"SELECT pg_advisory_xact_lock(hashtextextended('runtime.environments:' || $1, 0))",
						[teamId],
					);
					await c.query(
						"UPDATE runtime.environments SET is_default = false WHERE team_id = $1 AND is_default",
						[teamId],
					);
				}
				return fn(c);
			});
			return this.#record(row);
		} catch (e) {
			const code = pgCode(e);
			if (code === UNIQUE_VIOLATION) throw new IdentityError("name_taken");
			throw e;
		}
	}

	#encrypt(id: string, sets: SecretSets) {
		return this.#keys.encryptFor(
			ENVIRONMENT_AAD_PREFIX,
			id,
			JSON.stringify(sets),
		);
	}

	#record(r: EnvRow): EnvironmentRecord {
		const plain = this.#keys.decryptFor(ENVIRONMENT_AAD_PREFIX, r.id, {
			keyVersion: r.key_version,
			nonce: r.nonce,
			ciphertext: r.ciphertext,
		});
		return {
			id: r.id,
			teamId: r.team_id,
			name: r.name,
			isDefault: r.is_default,
			revision: r.revision,
			sets: JSON.parse(Buffer.from(plain).toString("utf8")) as SecretSets,
			repositories: r.repositories,
			excludeOwnerSecrets: r.exclude_owner_secrets,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
			updatedBy: r.updated_by,
		};
	}
}
