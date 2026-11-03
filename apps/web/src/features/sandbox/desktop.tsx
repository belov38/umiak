"use client";
import { useQuery } from "@tanstack/react-query";
import type { Sandbox, SandboxData } from "@umiak/sdk";
import { useEffect, useRef, useState } from "react";
import { ConfirmButton } from "@/components/app/confirm-button";
import { QueryError } from "@/components/app/query-error";
import { useLocalMode } from "@/components/app/session-context";
import { Button } from "@/components/ui/button";
import { useAttempt } from "@/lib/client-call";
import { fetchDesktopLink } from "./desktop-link";
import { headerActions } from "./rules";

export function DesktopTab({
	sandbox,
	handle,
	track,
}: {
	sandbox: SandboxData;
	handle: Sandbox;
	track: (id: string) => void;
}) {
	const attempt = useAttempt();
	const localMode = useLocalMode();
	const [url, setUrl] = useState<string | null>(null);
	const [error, setError] = useState<unknown>(null);
	const [revision, setRevision] = useState(0);
	const [busy, setBusy] = useState(false);
	const frame = useRef<HTMLIFrameElement>(null);
	const ready = sandbox.state === "ready" && !sandbox.blocked;
	const status = useQuery({
		queryKey: ["desktop", sandbox.id],
		queryFn: ({ signal }) => handle.desktop.status({ signal }),
		enabled: ready,
	});
	// biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly remints the single-use ticket after access changes or disconnect.
	useEffect(() => {
		setUrl(null);
		setError(null);
		if (!ready) return;
		const abort = new AbortController();
		void fetchDesktopLink(
			handle.desktop.link.bind(handle.desktop),
			abort.signal,
		).then(
			(link) => {
				if (!abort.signal.aborted) setUrl(link.url);
			},
			(e) => {
				if (!abort.signal.aborted) setError(e);
			},
		);
		return () => abort.abort();
	}, [handle, ready, revision]);
	const refresh = () => setRevision((v) => v + 1);
	if (!ready)
		return (
			<div className="space-y-3">
				<p>
					The sandbox must be ready to open its desktop (current state:{" "}
					{sandbox.state}).
				</p>
				{sandbox.state === "stopped" && (
					<Button
						disabled={busy || !headerActions(sandbox).resume}
						onClick={async () => {
							setBusy(true);
							const result = await attempt(() => handle.resume());
							setBusy(false);
							if (result) track(result.id);
						}}
					>
						Resume
					</Button>
				)}
			</div>
		);
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-2">
				<Button
					variant="outline"
					onClick={async () => {
						// Open synchronously to retain browser user activation, then mint a fresh ticket.
						const tab = window.open("about:blank", "_blank");
						if (!tab) return;
						tab.opener = null;
						const link = await attempt(() => handle.desktop.link());
						if (link) tab.location.replace(link.url);
						else tab.close();
					}}
				>
					Open in new tab
				</Button>
				<Button
					variant="outline"
					disabled={!url}
					onClick={() =>
						void attempt(
							() => frame.current?.requestFullscreen() ?? Promise.resolve(),
						)
					}
				>
					Full screen
				</Button>
				<label className="text-sm">
					Access{" "}
					<select
						aria-label="Desktop access"
						className="rounded border p-1"
						value={status.data?.access ?? "token"}
						disabled={busy || !status.data}
						onChange={async (event) => {
							const access = event.target.value as "token" | "sso" | "public";
							setBusy(true);
							const result = await attempt(() =>
								handle.desktop.setAccess(access),
							);
							setBusy(false);
							if (result) {
								await status.refetch();
								refresh();
							}
						}}
					>
						<option value="token">Secret link</option>
						{!localMode && <option value="sso">Team members</option>}
						<option value="public">Public</option>
					</select>
				</label>
				<ConfirmButton
					variant="outline"
					title="Disconnect all desktop viewers?"
					description="Active desktop streams will close."
					confirmLabel="Disconnect"
					onConfirm={async () => {
						const result = await attempt(() =>
							handle.desktop.endStreams().then(() => true),
						);
						if (result) refresh();
						return result === true;
					}}
				>
					Disconnect all viewers
				</ConfirmButton>
			</div>
			{status.error && (
				<QueryError
					error={status.error}
					what="desktop access"
					onRetry={() => status.refetch()}
				/>
			)}
			{error ? (
				<QueryError error={error} what="desktop" onRetry={refresh} />
			) : url ? (
				<iframe
					ref={frame}
					title="Sandbox desktop"
					src={url}
					allow="autoplay; fullscreen; clipboard-read; clipboard-write; keyboard-map"
					referrerPolicy="no-referrer"
					className="aspect-video w-full border-0"
				/>
			) : (
				<p role="status">The desktop is starting…</p>
			)}
		</div>
	);
}
