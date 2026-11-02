"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
// Ports tab (S8 §9.6): GET /ports; publish with access token/sso/public and
// hostRewrite (PUT /ports/{port}); the token and urlWithToken shown once
// in a dialog after a publish or a rotation; Rotate token, Unpublish; a
// blocked port shows the lock and its reason; `403 public_disabled` → a
// hint at the form.
import type { HostedPort, Sandbox, SandboxData } from "@umiak/sdk";
import { UmiakError } from "@umiak/sdk";
import { ExternalLinkIcon, LockIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ConfirmButton } from "@/components/app/confirm-button";
import { CopyButton, CopyLine } from "@/components/app/copy-button";
import { Field, FormDialog } from "@/components/app/form-dialog";
import { QueryError } from "@/components/app/query-error";
import { useLocalMode } from "@/components/app/session-context";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { attempt } from "@/lib/client-call";
import { describeError } from "@/lib/errors";
import { formatTime } from "@/lib/format";
import { blockText } from "../sandboxes/state-cell";
import { canConfigure, portProblem, portUrl } from "./rules";

type Access = "token" | "sso" | "public";
type HostRewrite = "preserve" | "localhost";

const ACCESS_TEXT: Record<Access, string> = {
	token: "token — a secret link",
	sso: "sso — anyone signed in to the platform",
	public: "public — anyone with the URL",
};

/** The token of a publish or rotation, shown once. */
interface ShownToken {
	port: number;
	token: string;
	urlWithToken: string;
	rotated: boolean;
}

export function portsKey(teamId: string, sandboxId: string) {
	return ["ports", teamId, sandboxId] as const;
}

function isPublicDisabled(e: unknown): boolean {
	return (
		e instanceof UmiakError &&
		e.code === "forbidden" &&
		e.details.reason === "public_disabled"
	);
}

export function PortsTab({
	teamId,
	sandbox,
	handle,
}: {
	teamId: string;
	sandbox: SandboxData;
	handle: Sandbox;
}) {
	const queryClient = useQueryClient();
	const key = portsKey(teamId, sandbox.id);
	const ports = useQuery({
		queryKey: key,
		queryFn: ({ signal }) => handle.ports.list({ signal }),
		refetchInterval: 10_000,
		refetchIntervalInBackground: false,
	});
	const [publish, setPublish] = useState<{
		port: string;
		current?: HostedPort;
	} | null>(null);
	const [shown, setShown] = useState<ShownToken | null>(null);
	const [publicOff, setPublicOff] = useState(false);
	const gate = canConfigure(sandbox);
	const refresh = () => queryClient.invalidateQueries({ queryKey: key });

	const rotate = async (p: HostedPort) => {
		const r = await attempt(() => handle.ports.rotateToken(p.port));
		if (r === undefined) return false;
		setShown({
			port: p.port,
			token: r.token,
			urlWithToken: r.urlWithToken,
			rotated: true,
		});
		return true;
	};

	const hosted = ports.data?.hosted ?? [];
	const listening = (ports.data?.listening ?? []).filter(
		(l) => !hosted.some((h) => h.port === l.port),
	);

	return (
		<div className="space-y-4">
			{ports.isError && (
				<QueryError
					error={ports.error}
					what="ports"
					onRetry={() => ports.refetch()}
				/>
			)}
			<section className="space-y-2">
				<div className="flex items-center gap-2">
					<h2 className="font-medium">Hosted</h2>
					<Button
						size="sm"
						variant="outline"
						className="ml-auto"
						disabled={!gate.ok}
						title={gate.ok ? undefined : gate.reason}
						onClick={() => setPublish({ port: "" })}
					>
						Publish a port…
					</Button>
				</div>
				{ports.data && hosted.length === 0 && (
					<p className="text-sm text-muted-foreground">No published ports.</p>
				)}
				<ul className="divide-y rounded-lg border" data-testid="hosted-ports">
					{hosted.map((p) => (
						<li
							key={p.port}
							className="flex flex-wrap items-center gap-2 p-2 text-sm"
							data-testid="hosted-port"
						>
							<span className="w-14 font-mono font-medium">{p.port}</span>
							{p.blocked && (
								<span
									className="flex items-center gap-1 text-warning"
									title={blockText(p)}
								>
									<LockIcon className="size-3.5" />
									<span className="text-xs">{blockText(p)}</span>
								</span>
							)}
							<a
								href={p.url}
								target="_blank"
								rel="noopener noreferrer"
								className="flex min-w-0 items-center gap-1 truncate font-mono text-xs underline"
							>
								{p.url}
								<ExternalLinkIcon className="size-3" />
							</a>
							<span className="rounded bg-muted px-1.5 text-xs">
								access: {p.access}
							</span>
							{p.hostRewrite === "localhost" && (
								<span className="rounded bg-muted px-1.5 text-xs">
									Host → localhost
								</span>
							)}
							<div className="ml-auto flex items-center gap-1">
								<Button asChild size="xs" variant="outline">
									<a href={p.url} target="_blank" rel="noopener noreferrer">
										Open
									</a>
								</Button>
								<CopyButton text={p.url} label="Copy URL" />
								<Button
									size="xs"
									variant="outline"
									disabled={!gate.ok || p.blocked}
									onClick={() =>
										setPublish({ port: String(p.port), current: p })
									}
								>
									Change…
								</Button>
								{p.access === "token" && (
									<ConfirmButton
										size="xs"
										title={`Rotate the token of port ${p.port}?`}
										description="The old token and its cookies stop working at once; the new one is shown once."
										confirmLabel="Rotate"
										disabled={!gate.ok || p.blocked}
										onConfirm={() => rotate(p)}
									>
										Rotate token
									</ConfirmButton>
								)}
								<ConfirmButton
									size="xs"
									title={`Unpublish port ${p.port}?`}
									description="The URL stops working at once; the app in the sandbox keeps running."
									confirmLabel="Unpublish"
									disabled={!gate.ok || p.blocked}
									onConfirm={async () => {
										const r = await attempt(() =>
											handle.ports.unhost(p.port).then(() => true),
										);
										await refresh();
										return r === true;
									}}
								>
									Unpublish
								</ConfirmButton>
							</div>
						</li>
					))}
				</ul>
			</section>
			<section className="space-y-2">
				<h2 className="font-medium">Listening (not published)</h2>
				{ports.data && listening.length === 0 && (
					<p className="text-sm text-muted-foreground">
						Nothing else listens
						{ports.data.listeningObservedAt === null
							? " (as last reported; the sandbox is not ready)"
							: ""}
						.
					</p>
				)}
				<ul className="divide-y rounded-lg border">
					{listening.map((l) => (
						<li key={l.port} className="flex items-center gap-2 p-2 text-sm">
							<span className="w-14 font-mono font-medium">{l.port}</span>
							<span className="text-muted-foreground">{l.process ?? "—"}</span>
							<span className="font-mono text-xs text-muted-foreground">
								{l.addresses.join(", ")}
							</span>
							<Button
								size="xs"
								variant="outline"
								className="ml-auto"
								disabled={!gate.ok}
								onClick={() => setPublish({ port: String(l.port) })}
							>
								Publish…
							</Button>
						</li>
					))}
				</ul>
				{ports.data?.listeningObservedAt && (
					<p className="text-xs text-muted-foreground">
						As of {formatTime(ports.data.listeningObservedAt)}.
					</p>
				)}
			</section>
			<PublishDialog
				handle={handle}
				sandbox={sandbox}
				target={publish}
				publicOff={publicOff}
				onPublicOff={() => setPublicOff(true)}
				onClose={() => setPublish(null)}
				onPublished={async (p) => {
					if (p.token && p.urlWithToken) {
						setShown({
							port: p.port,
							token: p.token,
							urlWithToken: p.urlWithToken,
							rotated: false,
						});
					} else toast.success(`Port ${p.port} is published`);
					await refresh();
				}}
			/>
			<TokenDialog shown={shown} onClose={() => setShown(null)} />
		</div>
	);
}

function PublishDialog({
	handle,
	sandbox,
	target,
	publicOff,
	onPublicOff,
	onClose,
	onPublished,
}: {
	handle: Sandbox;
	sandbox: SandboxData;
	target: { port: string; current?: HostedPort } | null;
	publicOff: boolean;
	onPublicOff: () => void;
	onClose: () => void;
	onPublished: (
		p: Awaited<ReturnType<Sandbox["ports"]["host"]>>,
	) => Promise<void>;
}) {
	const localMode = useLocalMode();
	const [port, setPort] = useState("");
	const [access, setAccess] = useState<Access>("token");
	const [rewrite, setRewrite] = useState<HostRewrite>("preserve");
	const [error, setError] = useState<string | null>(null);
	const fixed = target?.port !== "" && target !== null;
	const p = fixed ? (target?.port ?? "") : port;
	const problem = p === "" ? null : portProblem(p);
	const current = target?.current;
	useEffect(() => {
		if (target === null) return;
		setAccess((target.current?.access as Access | undefined) ?? "token");
		setRewrite(
			(target.current?.hostRewrite as HostRewrite | undefined) ?? "preserve",
		);
	}, [target]);

	return (
		<FormDialog
			open={target !== null}
			onOpenChange={(o) => {
				if (o) return;
				onClose();
				setError(null);
			}}
			title={
				current
					? `Port ${current.port}`
					: fixed
						? `Publish port ${p}`
						: "Publish a port"
			}
			description={
				<>
					URL:{" "}
					<code className="text-xs">
						{p !== "" && problem === null
							? portUrl(sandbox.endpoints.portUrlTemplate, Number(p))
							: sandbox.endpoints.portUrlTemplate}
					</code>
				</>
			}
			submitLabel={current ? "Save" : "Publish"}
			submitDisabled={
				p === "" || problem !== null || (access === "public" && publicOff)
			}
			onSubmit={async () => {
				setError(null);
				try {
					const r = await handle.ports.host(Number(p), {
						access,
						hostRewrite: rewrite,
					});
					await onPublished(r);
					setPort("");
					return true;
				} catch (e) {
					if (isPublicDisabled(e)) {
						onPublicOff();
						setError(
							"A platform operator turned public ports off. Use token (a secret link) or sso (people signed in to the platform).",
						);
					} else setError(describeError(e).message);
					return false;
				}
			}}
		>
			{!fixed && (
				<Field label="Port" error={problem} hint="1–65535, not 22">
					<Input
						inputMode="numeric"
						autoFocus
						value={port}
						onChange={(e) => setPort(e.target.value)}
					/>
				</Field>
			)}
			<fieldset className="grid gap-1 text-sm">
				<legend className="mb-1 font-medium">Access</legend>
				{(Object.keys(ACCESS_TEXT) as Access[])
					.filter((a) => !localMode || a !== "sso")
					.map((a) => (
						<label
							key={a}
							className={
								a === "public" && publicOff
									? "text-muted-foreground"
									: undefined
							}
						>
							<input
								type="radio"
								name="access"
								className="mr-2"
								checked={access === a}
								disabled={a === "public" && publicOff}
								onChange={() => setAccess(a)}
							/>
							{ACCESS_TEXT[a]}
							{a === "public" && publicOff && " (turned off by the operator)"}
						</label>
					))}
			</fieldset>
			<Field
				label="Host header"
				hint="localhost: for dev servers that check the Host (Vite, webpack)"
			>
				<select
					className="h-8 rounded-lg border bg-transparent px-2 text-sm"
					value={rewrite}
					onChange={(e) => setRewrite(e.target.value as HostRewrite)}
				>
					<option value="preserve">preserve — the public host</option>
					<option value="localhost">localhost:{p || "<port>"}</option>
				</select>
			</Field>
			{current && (
				<p className="text-xs text-muted-foreground">
					Saving replaces the settings (now: access {current.access}, Host{" "}
					{current.hostRewrite}). A switch to token issues a new token.
				</p>
			)}
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
		</FormDialog>
	);
}

/** The port token, shown once (same pattern as API key secrets, S8 §9.8). */
function TokenDialog({
	shown,
	onClose,
}: {
	shown: ShownToken | null;
	onClose: () => void;
}) {
	return (
		<Dialog open={shown !== null} onOpenChange={(o) => !o && onClose()}>
			{shown && (
				<DialogContent
					className="sm:max-w-2xl"
					showCloseButton={false}
					data-testid="port-token-dialog"
					onInteractOutside={(e) => e.preventDefault()}
					onEscapeKeyDown={(e) => e.preventDefault()}
				>
					<DialogHeader>
						<DialogTitle>
							{shown.rotated ? "New token of" : "Token of"} port {shown.port}
						</DialogTitle>
						<DialogDescription>
							Copy it now: it is not shown again (only its hash is stored). A
							lost token is replaced with “Rotate token”.
							{shown.rotated && " The old token has stopped working."}
						</DialogDescription>
					</DialogHeader>
					<p className="text-sm font-medium">Link with the token</p>
					<CopyLine
						text={shown.urlWithToken}
						label="Copy the link with the token"
					/>
					<p className="text-sm font-medium">Token</p>
					<CopyLine text={shown.token} label="Copy the token" />
					<DialogFooter>
						<Button onClick={onClose}>I have copied it</Button>
					</DialogFooter>
				</DialogContent>
			)}
		</Dialog>
	);
}
