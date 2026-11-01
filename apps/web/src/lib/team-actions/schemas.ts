// Input of the server actions (zod). Public ids are decoded here: a
// malformed id is a `validation` error.
import { decodeUuid } from "@umiak/auth";
import { z } from "zod";
import { decodeDashboardId } from "../ids";

/** teams.name: 1–64 characters after trimming (S8 §7). */
export const teamName = z
	.string()
	.trim()
	.min(1, "The name is required.")
	.max(64, "At most 64 characters.");

/** `team_…` → UUID. */
export const teamId = z.string().transform((v, c) => {
	const id = decodeUuid("team", v);
	if (id === null) {
		c.addIssue({ code: "custom", message: "Not a team id." });
		return z.NEVER;
	}
	return id;
});

/** `mbr_…` → UUID. */
export const membershipId = z.string().transform((v, c) => {
	const id = decodeDashboardId("membership", v);
	if (id === null) {
		c.addIssue({ code: "custom", message: "Not a membership id." });
		return z.NEVER;
	}
	return id;
});

/** `ntc_…` → UUID. */
export const noticeId = z.string().transform((v, c) => {
	const id = decodeDashboardId("teamNotice", v);
	if (id === null) {
		c.addIssue({ code: "custom", message: "Not a notice id." });
		return z.NEVER;
	}
	return id;
});

export const role = z.enum(["owner", "member"], {
	message: "The role is owner or member.",
});

/** Lower case, trimmed (users.email is stored that way). */
export const email = z
	.string()
	.trim()
	.toLowerCase()
	.pipe(z.email({ message: "Not a valid email address." }).max(254));
