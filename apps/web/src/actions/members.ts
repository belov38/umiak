"use server";
// Server actions of S8 §9.11: members. Logic in lib/team-actions/members.ts.
// Membership ids are dashboard ids (`mbr_…`, lib/ids.ts).
import { runAction } from "@/lib/action-context";
import type { TeamRole } from "@/lib/permissions";
import type { ActionResult } from "@/lib/team-actions/core";
import {
	inviteMemberImpl,
	leaveTeamImpl,
	removeMemberImpl,
	setRoleImpl,
} from "@/lib/team-actions/members";

export async function inviteMember(
	teamId: string,
	email: string,
	role: TeamRole,
): Promise<ActionResult<{ membershipId: string; stub: boolean }>> {
	return runAction((ctx) => inviteMemberImpl(ctx, { teamId, email, role }));
}

export async function setRole(
	membershipId: string,
	role: TeamRole,
): Promise<ActionResult> {
	return runAction((ctx) => setRoleImpl(ctx, { membershipId, role }));
}

export async function removeMember(
	membershipId: string,
): Promise<ActionResult> {
	return runAction((ctx) => removeMemberImpl(ctx, { membershipId }));
}

export async function leaveTeam(teamId: string): Promise<ActionResult> {
	return runAction((ctx) => leaveTeamImpl(ctx, { teamId }));
}
