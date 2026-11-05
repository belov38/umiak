"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useOwnerMode } from "@/components/app/session-context";
import { Button } from "@/components/ui/button";
import { useUmiak } from "@/lib/api";
import { teamPath } from "@/lib/team-path";

export function FirstSandboxAction({ teamId }: { teamId: string }) {
	const umiak = useUmiak(teamId);
	const owner = useOwnerMode();
	const templates = useQuery({
		queryKey: ["templates", teamId],
		queryFn: ({ signal }) => umiak.templates({ signal }),
	});
	const setup = useQuery({
		queryKey: ["setup-state"],
		enabled: owner,
		queryFn: async ({ signal }) => {
			const response = await fetch("/quickstart/setup/state", { signal });
			if (!response.ok) throw new Error("Could not load setup status");
			return (await response.json()) as { complete: boolean };
		},
	});
	const incomplete =
		(owner && setup.data?.complete === false) ||
		(templates.data !== undefined &&
			!templates.data.some((t) => t.enabled && t.version !== null));
	return (
		<Button asChild>
			<Link href={incomplete ? "/setup" : teamPath(teamId, "sandboxes/new")}>
				{incomplete ? "Finish setup" : "Create your first sandbox"}
			</Link>
		</Button>
	);
}
