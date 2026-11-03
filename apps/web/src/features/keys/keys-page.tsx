"use client";
// /app/t/<team>/keys (S8 §9.8): team API keys from GET /v1/api-keys. Every
// member sees them; New and Rotate are for owners, Revoke for owners and
// operators (§6.2). Keys whose creator left or was deactivated are marked;
// the IdP-sync notice (§20.1) sits above the table. Revoked and expired
// keys are collapsed at the bottom.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ConfirmButton } from "@/components/app/confirm-button";
import { EmptyState as DashboardEmpty } from "@/components/app/empty-state";
import { QueryError } from "@/components/app/query-error";
import {
	useSingleOwner,
	useTeamPermission,
} from "@/components/app/session-context";
import { TeamNotices } from "@/components/app/team-notices";
import { Badge } from "@/components/ui/badge";
import { LoadingState } from "@/components/ui/feedback";
import { PageHeader, Panel } from "@/components/ui/panel";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useUmiak } from "@/lib/api";
import {
	type ApiKey,
	creatorNote,
	maskedKey,
	partitionKeys,
	presetOf,
} from "@/lib/api-keys";
import { useAttempt } from "@/lib/client-call";
import { formatAgo, formatDate } from "@/lib/format";
import { can } from "@/lib/permissions";
import type { TeamNoticeView } from "@/lib/team-actions/team-settings";
import { NewKeyForm } from "./new-key-form";
import { SecretDialog, type ShownSecret } from "./secret-dialog";

export function KeysPage({
	teamId,
	notices,
}: {
	teamId: string;
	notices: TeamNoticeView[];
}) {
	const attempt = useAttempt();
	const singleOwner = useSingleOwner();
	const umiak = useUmiak(teamId);
	const queryClient = useQueryClient();
	const { session, team } = useTeamPermission(teamId);
	const canIssue = can(session, team, "issueApiKeys");
	const canRevoke = can(session, team, "revokeApiKeys");
	const [shown, setShown] = useState<ShownSecret | null>(null);

	const keys = useQuery({
		queryKey: ["api-keys", teamId],
		queryFn: async ({ signal }) => {
			const { data } = await umiak.raw.GET("/v1/api-keys", { signal });
			return data.data;
		},
	});
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: ["api-keys", teamId] });

	const rotate = async (k: ApiKey): Promise<boolean> => {
		const r = await attempt(async () => {
			const { data } = await umiak.raw.POST("/v1/api-keys/{key}/rotate", {
				params: { path: { key: k.id } },
			});
			return data;
		});
		await refresh();
		if (r === undefined) return false;
		setShown({ keyName: r.apiKey.name, secret: r.secret, rotated: true });
		return true;
	};

	const revoke = async (k: ApiKey): Promise<boolean> => {
		const r = await attempt(() =>
			umiak.raw.DELETE("/v1/api-keys/{key}", {
				params: { path: { key: k.id } },
			}),
		);
		await refresh();
		if (r === undefined) return false;
		toast.success(`Revoked ${k.name}`);
		return true;
	};

	const now = Date.now();
	const { live, inactive } = partitionKeys(keys.data ?? [], now);
	const team0 = session.teams.find((t) => t.id === teamId);

	return (
		<section className="space-y-4">
			{!singleOwner && (
				<TeamNotices
					teamId={teamId}
					notices={notices}
					canAcknowledge={can(session, team, "acknowledgeNotice")}
					canRevoke={canRevoke}
				/>
			)}
			<PageHeader title="API keys" />
			<Panel className="keys-card">
				<div className="key-intro">
					<h2>
						{singleOwner ? "Automation keys" : `${team0?.name ?? "Team"} keys`}
					</h2>
					<p className="text-sm text-muted-foreground">
						{singleOwner ? (
							<>
								Keys let CI and agents access this deployment with selected
								scopes. For the CLI, use <code>umiak login</code>.
							</>
						) : (
							<>
								Keys are for CI and agents and belong to the team. People do not
								need one: run <code>umiak login</code> to use the CLI with your
								own account.
								{!canIssue &&
									" Only an owner of the team can issue and rotate keys."}
							</>
						)}
					</p>
				</div>
				{canIssue && (
					<NewKeyForm
						teamId={teamId}
						onIssued={async (secret) => {
							setShown(secret);
							await refresh();
						}}
					/>
				)}

				{keys.isError && (
					<QueryError
						error={keys.error}
						what="API keys"
						onRetry={() => keys.refetch()}
					/>
				)}
				{keys.isPending && <LoadingState />}
				{keys.data && live.length === 0 && (
					<DashboardEmpty kind="keys">No active keys.</DashboardEmpty>
				)}
				{live.length > 0 && (
					<KeyTable
						keys={live}
						now={now}
						actions={(k) => (
							<>
								{canIssue && (
									<ConfirmButton
										title={`Rotate ${k.name}?`}
										description="A new secret is issued and the old one stops working at once everywhere it is used."
										confirmLabel="Rotate"
										size="xs"
										onConfirm={() => rotate(k)}
									>
										Rotate
									</ConfirmButton>
								)}
								{canRevoke && (
									<ConfirmButton
										title={`Revoke ${k.name}?`}
										description="It stops working at once on every server; its open streams and terminals are closed. This cannot be undone."
										confirmLabel="Revoke"
										variant="ghost"
										size="xs"
										onConfirm={() => revoke(k)}
									>
										Revoke
									</ConfirmButton>
								)}
							</>
						)}
					/>
				)}
				{inactive.length > 0 && (
					<details className="group" data-testid="inactive-keys">
						<summary className="cursor-pointer text-sm text-muted-foreground select-none">
							Revoked and expired ({inactive.length})
						</summary>
						<div className="pt-2 opacity-70">
							<KeyTable keys={inactive} now={now} />
						</div>
					</details>
				)}
			</Panel>
			<SecretDialog shown={shown} onClose={() => setShown(null)} />
		</section>
	);
}

function ScopesCell({ scopes }: { scopes: ApiKey["scopes"] }) {
	const preset = presetOf(scopes);
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className="cursor-default">
					{preset ?? `${scopes.length} scope${scopes.length === 1 ? "" : "s"}`}
				</span>
			</TooltipTrigger>
			<TooltipContent className="max-w-80">
				<code className="text-xs">{scopes.join(" ")}</code>
			</TooltipContent>
		</Tooltip>
	);
}

function KeyTable({
	keys,
	now,
	actions,
}: {
	keys: ApiKey[];
	now: number;
	actions?: (k: ApiKey) => ReactNode;
}) {
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Name</TableHead>
					<TableHead>Key</TableHead>
					<TableHead>Scopes</TableHead>
					<TableHead>Created by</TableHead>
					<TableHead>Expires</TableHead>
					<TableHead>Last used</TableHead>
					{actions && <TableHead />}
				</TableRow>
			</TableHeader>
			<TableBody>
				{keys.map((k) => {
					const note = creatorNote(k);
					return (
						<TableRow key={k.id} data-testid="key-row">
							<TableCell className="font-medium">{k.name}</TableCell>
							<TableCell>
								<code className="text-xs">{maskedKey(k)}</code>
							</TableCell>
							<TableCell>
								<ScopesCell scopes={k.scopes} />
							</TableCell>
							<TableCell>
								{k.createdBy?.email ?? "—"}
								{note && (
									<Badge
										variant="warning"
										className="ml-2"
										data-testid="creator-note"
									>
										{note}
									</Badge>
								)}
								<div className="text-xs text-muted-foreground">
									{formatDate(k.createdAt)} via {k.createdVia}
								</div>
							</TableCell>
							<TableCell>
								{k.revokedAt ? (
									<Badge variant="secondary">
										revoked {formatDate(k.revokedAt)}
									</Badge>
								) : Date.parse(k.expiresAt) <= now ? (
									<Badge variant="secondary">
										expired {formatDate(k.expiresAt)}
									</Badge>
								) : (
									formatDate(k.expiresAt)
								)}
							</TableCell>
							<TableCell>
								{k.lastUsedAt ? formatAgo(k.lastUsedAt, now) : "never"}
							</TableCell>
							{actions && (
								<TableCell>
									<div className="flex justify-end gap-1">{actions(k)}</div>
								</TableCell>
							)}
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}
