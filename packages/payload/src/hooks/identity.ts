// NOTIFY sbx_identity '<collection>:<uuid>' (S8 §8, S7 §7.2, §7.4) from the
// identity collections. Memberships send '<userUuid>:<teamUuid>' (S7 §23.10,
// the stand-in format): api maps it to the streams of the removed member,
// which a membership id cannot do after a delete. As the
// stand-in trigger (db/migrations/0300), updates that only touch the
// bookkeeping fields (lastUsedAt, lastLoginAt, updatedAt) send nothing.
import type {
	CollectionAfterChangeHook,
	CollectionAfterDeleteHook,
} from "payload";
import { notify } from "../notify.ts";
import { changedFields, relId } from "./doc.ts";

export type IdentityCollection =
	| "users"
	| "teams"
	| "memberships"
	| "api-keys"
	| "ssh-keys";

const BOOKKEEPING = new Set(["lastUsedAt", "lastLoginAt", "updatedAt"]);

function key(slug: IdentityCollection, doc: Record<string, unknown>): string {
	if (slug === "memberships") {
		return `memberships:${relId(doc.user)}:${relId(doc.team)}`;
	}
	return `${slug}:${doc.id}`;
}

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
			// A changed key (memberships cannot change theirs) notifies both.
			const before = key(slug, previousDoc);
			if (before !== key(slug, doc)) {
				await notify(req, "sbx_identity", before);
			}
		}
		await notify(req, "sbx_identity", key(slug, doc));
		return doc;
	};
}

export function identityAfterDelete(
	slug: IdentityCollection,
): CollectionAfterDeleteHook {
	return async ({ id, req, doc }) => {
		await notify(req, "sbx_identity", key(slug, { id, ...doc }));
		return doc;
	};
}
