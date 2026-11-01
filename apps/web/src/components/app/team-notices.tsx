"use client";
// Banner of the IdP sync notices (S8 §9.8, §20.1): a member was deactivated
// in the IdP; the team keys they created keep working until an owner
// revokes them. "Revoke selected" calls DELETE /v1/api-keys/{id} through
// the SDK, "Dismiss" acknowledges the notice (owners).
import { useQueryClient } from "@tanstack/react-query";
import { TriangleAlertIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { acknowledgeNotice } from "@/actions/notices";
import { ConfirmButton } from "@/components/app/confirm-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useUmiak } from "@/lib/api";
import { attempt } from "@/lib/client-call";
import { describeError } from "@/lib/errors";
import { formatTime } from "@/lib/format";
import type { TeamNoticeView } from "@/lib/team-actions/team-settings";

export function TeamNotices({
	teamId,
	notices,
	canAcknowledge,
	canRevoke,
}: {
	teamId: string;
	notices: TeamNoticeView[];
	canAcknowledge: boolean;
	canRevoke: boolean;
}) {
	if (notices.length === 0) return null;
	return (
		<div className="space-y-3" data-testid="team-notices">
			{notices.map((n) => (
				<Notice
					key={n.id}
					teamId={teamId}
					notice={n}
					canAcknowledge={canAcknowledge}
					canRevoke={canRevoke}
				/>
			))}
		</div>
	);
}

function Notice({
	teamId,
	notice,
	canAcknowledge,
	canRevoke,
}: {
	teamId: string;
	notice: TeamNoticeView;
	canAcknowledge: boolean;
	canRevoke: boolean;
}) {
	const umiak = useUmiak(teamId);
	const router = useRouter();
	const queryClient = useQueryClient();
	const live = notice.apiKeys.filter((k) => !k.revoked);
	const [selected, setSelected] = useState<Set<string>>(
		() => new Set(live.map((k) => k.id)),
	);
	const [dismissing, setDismissing] = useState(false);
	const who = notice.user?.email ?? "A former member";

	const toggle = (id: string, on: boolean) =>
		setSelected((s) => {
			const next = new Set(s);
			if (on) next.add(id);
			else next.delete(id);
			return next;
		});

	async function revokeSelected(): Promise<boolean> {
		const ids = live.map((k) => k.id).filter((id) => selected.has(id));
		const failed: string[] = [];
		for (const id of ids) {
			try {
				await umiak.raw.DELETE("/v1/api-keys/{key}", {
					params: { path: { key: id } },
				});
			} catch (e) {
				failed.push(`${id}: ${describeError(e).message}`);
			}
		}
		await queryClient.invalidateQueries({ queryKey: ["api-keys", teamId] });
		router.refresh();
		if (failed.length > 0) {
			toast.error(`Could not revoke ${failed.length} key(s)`, {
				description: failed.join("\n"),
			});
			return false;
		}
		toast.success(`Revoked ${ids.length} key(s)`);
		return true;
	}

	async function dismiss() {
		setDismissing(true);
		try {
			const r = await attempt(() => acknowledgeNotice(notice.id));
			if (r === undefined) return;
			if ("error" in r) toast.error(r.error.message);
			else router.refresh();
		} finally {
			setDismissing(false);
		}
	}

	return (
		<div
			role="alert"
			className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
		>
			<div className="flex items-start gap-2">
				<TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
				<div className="flex-1 space-y-2">
					<p>
						<span className="font-medium">{who}</span> was deactivated in the
						identity provider ({formatTime(notice.createdAt)}).{" "}
						{notice.apiKeys.length === 0
							? "They created no team API keys."
							: "Team API keys they created keep working until an owner revokes them."}
					</p>
					{notice.apiKeys.length > 0 && (
						<ul className="space-y-1">
							{notice.apiKeys.map((k) => (
								<li key={k.id} className="flex items-center gap-2">
									<input
										type="checkbox"
										className="size-4"
										aria-label={`Select key ${k.name}`}
										disabled={k.revoked || !canRevoke}
										checked={!k.revoked && selected.has(k.id)}
										onChange={(e) => toggle(k.id, e.target.checked)}
									/>
									<span className="font-medium">{k.name}</span>
									<code className="text-xs">{k.prefix}…</code>
									{k.revoked && <Badge variant="secondary">revoked</Badge>}
								</li>
							))}
						</ul>
					)}
					<div className="flex flex-wrap gap-2">
						{canRevoke && live.length > 0 && (
							<ConfirmButton
								title="Revoke the selected keys?"
								description="They stop working at once on every server. This cannot be undone."
								confirmLabel="Revoke"
								variant="destructive"
								disabled={live.filter((k) => selected.has(k.id)).length === 0}
								onConfirm={revokeSelected}
							>
								Revoke selected
							</ConfirmButton>
						)}
						{canAcknowledge && (
							<Button
								size="sm"
								variant="outline"
								disabled={dismissing}
								onClick={dismiss}
							>
								Dismiss
							</Button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
