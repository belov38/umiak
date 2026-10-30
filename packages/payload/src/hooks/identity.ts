// NOTIFY sbx_identity '<collection>:<uuid>' (S8 §8, S7 §7.2, §7.4) from the
// identity collections; memberships send the id of the membership. As the
// stand-in trigger (db/migrations/0300), updates that only touch the
// bookkeeping fields (lastUsedAt, lastLoginAt, updatedAt) send nothing.
import type {
	CollectionAfterChangeHook,
	CollectionAfterDeleteHook,
} from "payload";
import { notify } from "../notify.ts";
import { changedFields } from "./doc.ts";

export type IdentityCollection =
	| "users"
	| "teams"
	| "memberships"
	| "api-keys"
	| "ssh-keys";

const BOOKKEEPING = new Set(["lastUsedAt", "lastLoginAt", "updatedAt"]);

export function identityAfterChange(
	slug: IdentityCollection,
): CollectionAfterChangeHook {
	return async ({ collection, doc, previousDoc, operation, req }) => {
		if (operation === "update") {
			const changed = changedFields(
				collection.flattenedFields,
				previousDoc,
				doc,
			);
			if (![...changed].some((f) => !BOOKKEEPING.has(f))) return doc;
		}
		await notify(req, "sbx_identity", `${slug}:${doc.id}`);
		return doc;
	};
}

export function identityAfterDelete(
	slug: IdentityCollection,
): CollectionAfterDeleteHook {
	return async ({ id, req, doc }) => {
		await notify(req, "sbx_identity", `${slug}:${doc?.id ?? id}`);
		return doc;
	};
}
