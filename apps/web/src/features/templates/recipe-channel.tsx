"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Build = {
	id: string;
	template_slug: string;
	node_id: string;
	version: string;
	status: string;
	recipe_version?: string;
};
type Channel = {
	enabled: boolean;
	auto: boolean;
	intervalHours: number;
	following?: string;
	available?: { version: string; changelog: string };
	error?: string;
	progress?: string;
	history?: {
		at: string;
		slug: string;
		version: string;
		status: string;
		error?: string;
	}[];
};
export function RecipeChannelPanel() {
	const client = useQueryClient();
	const [error, setError] = useState("");
	const request = async (body?: object) => {
		const r = await fetch(
			"/quickstart/setup/recipes",
			body
				? {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
					}
				: {},
		);
		const result = await r.json();
		if (!r.ok) throw Error(result.error);
		return result as { channel: Channel; builds: Build[] };
	};
	const query = useQuery({
		queryKey: ["recipe-channel"],
		queryFn: () => request(),
		refetchInterval: 5000,
	});
	const change = async (body: object) => {
		try {
			setError("");
			await request(body);
			await client.invalidateQueries({ queryKey: ["recipe-channel"] });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};
	if (!query.data)
		return <p>{query.error?.message || "Loading recipe channel…"}</p>;
	const { channel: c, builds } = query.data;
	return (
		<div className="space-y-3 border p-4">
			<h2 className="font-semibold">
				Recipe updates · {c.following || "stable"}
			</h2>
			<p>
				{c.available
					? `Available: ${c.available.version}`
					: "Using baked-in recipes"}{" "}
				· {c.progress}
			</p>
			<div className="flex flex-wrap gap-3">
				<Button
					variant="outline"
					onClick={() => void change({ enabled: !c.enabled })}
				>
					{c.enabled ? "Disable checks" : "Enable checks"}
				</Button>
				<Button
					variant="outline"
					onClick={() => void change({ auto: !c.auto })}
				>
					{c.auto ? "Pause auto-update" : "Resume auto-update"}
				</Button>
				<Button variant="outline" onClick={() => void change({ retry: true })}>
					Check / Retry
				</Button>
				<label>
					Check every{" "}
					<Input
						aria-label="Recipe check interval hours"
						type="number"
						min={1}
						max={168}
						defaultValue={c.intervalHours}
						onBlur={(e) =>
							void change({ intervalHours: Number(e.target.value) })
						}
						className="w-16 border px-2"
					/>{" "}
					hours
				</label>
			</div>
			{(c.error || error) && <p role="alert">{error || c.error}</p>}
			{c.available && (
				<details>
					<summary>Changelog</summary>
					<pre className="whitespace-pre-wrap text-xs">
						{c.available.changelog}
					</pre>
				</details>
			)}
			<ul>
				{builds.map((b) => (
					<li key={b.id} className="flex items-center gap-3 py-1">
						<span>
							{b.template_slug} · {b.node_id} · {b.version} · recipe{" "}
							{b.recipe_version || "baked-in"} · {b.status}
						</span>
						{b.status === "deprecated" && (
							<Button
								variant="outline"
								onClick={() => void change({ rollback: b.id })}
							>
								Roll back (pauses updates)
							</Button>
						)}
					</li>
				))}
			</ul>
			<details>
				<summary>Rollout history</summary>
				<ul>
					{c.history?.map((h) => (
						<li key={`${h.at}-${h.slug}`}>
							{h.at} · {h.slug} · {h.version} · {h.status} {h.error}
						</li>
					))}
				</ul>
			</details>
		</div>
	);
}
