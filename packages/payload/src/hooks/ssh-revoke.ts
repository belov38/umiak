// NOTIFY sbx_ssh_revoke for open SSH sessions (S8 §8, S4 §9.5), the payloads
// of the stand-in triggers (db/migrations/0302, 0303) with public ids:
//   user deactivated or deleted while active -> user:<usr_...>
//   membership deleted                      -> member:<team_...>:<usr_...>
//   key revoked, rotated or deleted while live -> key:<key_...>
//   team deleted                            -> team:<team_...>
import { encodeUuid } from "@sbx/auth";
import type {
	CollectionAfterChangeHook,
	CollectionAfterDeleteHook,
} from "payload";
import { notify } from "../notify.ts";
import { relId } from "./doc.ts";

const userPayload = (id: unknown) => `user:${encodeUuid("user", String(id))}`;
const keyPayload = (id: unknown) => `key:${encodeUuid("apiKey", String(id))}`;

export const usersRevokeAfterChange: CollectionAfterChangeHook = async ({
	doc,
	previousDoc,
	operation,
	req,
}) => {
	if (
		operation === "update" &&
		previousDoc?.active !== false &&
		doc.active === false
	) {
		await notify(req, "sbx_ssh_revoke", userPayload(doc.id));
	}
	return doc;
};

export const usersRevokeAfterDelete: CollectionAfterDeleteHook = async ({
	doc,
	req,
}) => {
	if (doc?.active !== false) {
		await notify(req, "sbx_ssh_revoke", userPayload(doc.id));
	}
	return doc;
};

export const membershipsRevokeAfterDelete: CollectionAfterDeleteHook = async ({
	doc,
	req,
}) => {
	const team = relId(doc.team);
	const user = relId(doc.user);
	if (team !== null && user !== null) {
		await notify(
			req,
			"sbx_ssh_revoke",
			`member:${encodeUuid("team", team)}:${encodeUuid("user", user)}`,
		);
	}
	return doc;
};

export const apiKeysRevokeAfterChange: CollectionAfterChangeHook = async ({
	data,
	doc,
	previousDoc,
	operation,
	req,
}) => {
	if (operation !== "update" || previousDoc?.revokedAt) return doc;
	// secretHash is hidden from access-checked reads; the written value is in data.
	const prevHash = previousDoc?.secretHash;
	const nextHash = doc.secretHash ?? data?.secretHash;
	const rotated =
		prevHash !== undefined && nextHash !== undefined && prevHash !== nextHash;
	if (doc.revokedAt || rotated) {
		await notify(req, "sbx_ssh_revoke", keyPayload(doc.id));
	}
	return doc;
};

export const apiKeysRevokeAfterDelete: CollectionAfterDeleteHook = async ({
	doc,
	req,
}) => {
	if (!doc?.revokedAt) await notify(req, "sbx_ssh_revoke", keyPayload(doc.id));
	return doc;
};

export const teamsRevokeAfterDelete: CollectionAfterDeleteHook = async ({
	doc,
	req,
}) => {
	await notify(
		req,
		"sbx_ssh_revoke",
		`team:${encodeUuid("team", String(doc.id))}`,
	);
	return doc;
};
