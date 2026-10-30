"use server";
// Server actions of S8 §9.11: the account. Logic in lib/team-actions/account.ts.
import { runAction } from "@/lib/action-context";
import { setDefaultTeamImpl } from "@/lib/team-actions/account";
import type { ActionResult } from "@/lib/team-actions/core";

export async function setDefaultTeam(teamId: string): Promise<ActionResult> {
	return runAction((ctx) => setDefaultTeamImpl(ctx, { teamId }));
}
