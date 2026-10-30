"use server";
// Server actions of S8 §9.11: teams. Logic in lib/team-actions/teams.ts.
import { runAction } from "@/lib/action-context";
import type { ActionResult } from "@/lib/team-actions/core";
import { createTeamImpl, renameTeamImpl } from "@/lib/team-actions/teams";

export async function createTeam(
	name: string,
): Promise<ActionResult<{ teamId: string }>> {
	return runAction((ctx) => createTeamImpl(ctx, { name }));
}

export async function renameTeam(
	teamId: string,
	name: string,
): Promise<ActionResult> {
	return runAction((ctx) => renameTeamImpl(ctx, { teamId, name }));
}
