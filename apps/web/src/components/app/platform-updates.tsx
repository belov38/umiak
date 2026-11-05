"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";

type Policy = {
	channel: "stable" | "edge";
	auto: boolean;
	paused: boolean;
	start: string;
	end: string;
};
type History = {
	status: string;
	from?: string;
	to?: string;
	finishedAt?: string;
	message?: string;
	dataLoss?: boolean;
};
type UpdateInfo = {
	settings: Policy;
	status: { updating?: boolean };
	history: History[];
	runningVersion: string;
};
function useUpdates() {
	const [info, setInfo] = useState<UpdateInfo | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		const read = () =>
			fetch("/owner/updates", {
				headers: { accept: "application/json" },
				signal: controller.signal,
			})
				.then(async (r) => {
					if (r.ok) setInfo(await r.json());
				})
				.catch(() => {});
		void read();
		const timer = setInterval(read, 5000);
		return () => {
			controller.abort();
			clearInterval(timer);
		};
	}, []);
	return { info, setInfo };
}

export function PlatformUpdateBanner() {
	const { info } = useUpdates();
	return info?.status.updating ? (
		<div role="status" className="border-b bg-muted px-6 py-3 text-sm">
			Updating Umiak… The control plane may reconnect briefly. Running sandboxes
			keep running.
		</div>
	) : null;
}

export function PlatformUpdates() {
	const { info, setInfo } = useUpdates();
	const [policy, setPolicy] = useState<Policy | null>(null);
	const [message, setMessage] = useState("");
	const [saving, setSaving] = useState(false);
	useEffect(() => {
		if (info && !policy) setPolicy(info.settings);
	}, [info, policy]);
	if (!info || !policy)
		return (
			<Panel>
				<h2 className="font-semibold">Updates</h2>
				<p className="text-sm text-muted-foreground">
					Loading host update settings…
				</p>
			</Panel>
		);
	const change = (patch: Partial<Policy>) => setPolicy({ ...policy, ...patch });
	const save = async () => {
		setSaving(true);
		setMessage("");
		try {
			const r = await fetch("/owner/updates", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json",
				},
				body: JSON.stringify(policy),
			});
			if (!r.ok)
				throw Error(
					"Could not save update settings. Check the maintenance window and try again.",
				);
			setInfo(await r.json());
			setMessage("Saved. The host checks this policy every 15 minutes.");
		} catch (e) {
			setMessage(
				e instanceof Error ? e.message : "Could not save update settings.",
			);
		} finally {
			setSaving(false);
		}
	};
	return (
		<Panel className="space-y-4">
			<h2 className="font-semibold">Updates</h2>
			<p className="text-sm">
				Running {info.runningVersion} · {info.settings.channel}
			</p>
			{info.runningVersion.startsWith("dev-") && (
				<p role="status" className="text-sm text-amber-600">
					Dev build: Update replaces this build with a published release.
				</p>
			)}
			{!info.settings.auto && (
				<p className="text-sm text-muted-foreground">
					Automatic updates are available. Enable them below, or keep
					notify-only mode.
				</p>
			)}
			<label className="flex items-center gap-3 text-sm">
				Channel
				<select
					className="rounded border bg-background p-2"
					value={policy.channel}
					onChange={(e) =>
						change({ channel: e.target.value as Policy["channel"] })
					}
				>
					<option value="stable">Stable</option>
					<option value="edge">Edge</option>
				</select>
			</label>
			<p className="text-sm text-muted-foreground">
				Template recipes follow this channel. Edge releases may be less
				reliable. Changing channel takes effect on the next host check.
			</p>
			<label className="flex items-center gap-2 text-sm">
				<input
					type="checkbox"
					checked={policy.auto}
					onChange={(e) => change({ auto: e.target.checked })}
				/>
				Automatically install platform updates
			</label>
			<label className="flex items-center gap-2 text-sm">
				<input
					type="checkbox"
					checked={policy.paused}
					onChange={(e) => change({ paused: e.target.checked })}
				/>
				Pause platform updates
			</label>
			<div className="flex flex-wrap items-center gap-3 text-sm">
				<label>
					From{" "}
					<input
						className="rounded border bg-background p-2"
						type="time"
						required
						value={policy.start}
						onChange={(e) => change({ start: e.target.value })}
					/>
				</label>
				<label>
					Until{" "}
					<input
						className="rounded border bg-background p-2"
						type="time"
						required
						value={policy.end}
						onChange={(e) => change({ end: e.target.value })}
					/>
				</label>
				<span className="text-muted-foreground">Proxmox host local time</span>
			</div>
			<p className="text-sm text-muted-foreground">
				Every update first backs up the database and state; the last three
				backups are kept. Rollback after incompatible migrations restores that
				backup and loses writes made since it. Running sandboxes are kept.
			</p>
			<Button disabled={saving || !!info.status.updating} onClick={save}>
				{saving ? "Saving…" : "Save update settings"}
			</Button>
			<p role="status" className="text-sm">
				{message}
			</p>
			<h3 className="font-medium">Update history</h3>
			{info.history.length ? (
				<ul className="space-y-2 text-sm">
					{info.history.slice(0, 20).map((event) => (
						<li key={`${event.finishedAt}-${event.status}-${event.to}`}>
							<span>
								{event.status}: {event.from || "—"} → {event.to || "—"}
							</span>
							{event.finishedAt && (
								<time
									className="ml-2 text-muted-foreground"
									dateTime={event.finishedAt}
								>
									{new Date(event.finishedAt).toLocaleString()}
								</time>
							)}
							{event.message && <p>{event.message}</p>}
							{event.dataLoss && (
								<p className="text-amber-600">
									Pre-update data restored; writes since the backup were lost.
								</p>
							)}
						</li>
					))}
				</ul>
			) : (
				<p className="text-sm text-muted-foreground">
					No platform update events yet.
				</p>
			)}
		</Panel>
	);
}
