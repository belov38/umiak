"use server";
// Server actions of S8 §9.11: team notices (§20.1). Notice ids are
// dashboard ids (`ntc_…`, lib/ids.ts). Logic in lib/team-actions/notices.ts.
import { runAction } from "@/lib/action-context";
import type { ActionResult } from "@/lib/team-actions/core";
import { acknowledgeNoticeImpl } from "@/lib/team-actions/notices";

export async function acknowledgeNotice(
	noticeId: string,
): Promise<ActionResult> {
	return runAction((ctx) => acknowledgeNoticeImpl(ctx, { noticeId }));
}
