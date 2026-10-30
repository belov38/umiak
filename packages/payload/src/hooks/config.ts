// NOTIFY sbx_config '<collection-or-global>:<id>' (S8 §8) for the readers of
// the platform config (ConfigReader of api and worker, S6 §5.11).
import type {
	CollectionAfterChangeHook,
	CollectionAfterDeleteHook,
	GlobalAfterChangeHook,
} from "payload";
import { notify } from "../notify.ts";
import { changedFields } from "./doc.ts";

export type ConfigCollection = "templates" | "sizes" | "pool-targets" | "teams";

export function configAfterChange(
	slug: ConfigCollection,
): CollectionAfterChangeHook {
	return async ({ doc, req }) => {
		await notify(req, "sbx_config", `${slug}:${doc.id}`);
		return doc;
	};
}

export function configAfterDelete(
	slug: ConfigCollection,
): CollectionAfterDeleteHook {
	return async ({ id, doc, req }) => {
		await notify(req, "sbx_config", `${slug}:${doc?.id ?? id}`);
		return doc;
	};
}

/** Teams are config only through their quota. */
export const teamsConfigAfterChange: CollectionAfterChangeHook = async ({
	collection,
	doc,
	previousDoc,
	operation,
	req,
}) => {
	if (
		operation === "create" ||
		changedFields(collection.flattenedFields, previousDoc, doc).has("quota")
	) {
		await notify(req, "sbx_config", `teams:${doc.id}`);
	}
	return doc;
};

export const platformDefaultsConfigAfterChange: GlobalAfterChangeHook = async ({
	doc,
	req,
}) => {
	await notify(req, "sbx_config", "platform-defaults:global");
	return doc;
};
