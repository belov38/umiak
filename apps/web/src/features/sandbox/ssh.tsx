"use client";
import { useQuery } from "@tanstack/react-query";
// SSH tab (S8 §9.6): GET /sandboxes/{sb}/ssh — the command, the
// known_hosts lines with copy, and a link to the account's SSH keys when
// the person has none (`hasKeys: false`).
import type { Sandbox, SandboxData } from "@umiak/sdk";
import { CopyLine } from "@/components/app/copy-button";
import { QueryError } from "@/components/app/query-error";
import { LoadingState } from "@/components/ui/feedback";
import Link from "@/components/ui/link";

export function SshTab({
	teamId,
	sandbox,
	handle,
}: {
	teamId: string;
	sandbox: SandboxData;
	handle: Sandbox;
}) {
	const q = useQuery({
		queryKey: ["ssh", teamId, sandbox.id],
		queryFn: async ({ signal }) => {
			const { data } = await handle.core.raw.GET(
				"/v1/sandboxes/{sandbox}/ssh",
				{
					params: { path: { sandbox: sandbox.id } },
					signal,
				},
			);
			return data;
		},
		staleTime: 60_000,
	});
	if (q.isError)
		return (
			<QueryError
				error={q.error}
				what="SSH access"
				onRetry={() => q.refetch()}
			/>
		);
	if (!q.data) return <LoadingState />;
	const s = q.data;
	return (
		<div className="max-w-3xl space-y-4 text-sm">
			{sandbox.blocked && (
				<p className="text-warning">
					The sandbox is blocked: SSH logins are refused.
				</p>
			)}
			{!s.hasKeys && (
				<p
					className="border border-warning/35 bg-warning-tint p-3 text-warning"
					data-testid="ssh-no-keys"
				>
					You have no SSH keys yet.{" "}
					<Link href="/app/account" className="underline">
						Add one to your account
					</Link>{" "}
					to use plain <code>ssh</code>, or use the CLI:{" "}
					<code>umiak ssh {sandbox.slug}</code> signs a short-lived certificate.
				</p>
			)}
			<section className="space-y-1">
				<h2 className="font-medium">Connect</h2>
				<CopyLine text={s.command} label="Copy the SSH command" />
				<p className="text-xs text-muted-foreground">
					Host {s.host}, port {s.port}, user <code>{s.username}</code>; you log
					in as <code>{s.loginUser}</code> in the guest.
				</p>
			</section>
			<section className="space-y-1">
				<h2 className="font-medium">known_hosts</h2>
				<p className="text-xs text-muted-foreground">
					Host keys of the gateway (the same for every sandbox). Add them to{" "}
					<code>~/.ssh/known_hosts</code>.
				</p>
				{s.knownHosts.length > 0 ? (
					<CopyLine
						text={s.knownHosts.join("\n")}
						label="Copy the known_hosts lines"
					/>
				) : (
					<p className="text-muted-foreground">Not configured.</p>
				)}
			</section>
		</div>
	);
}
