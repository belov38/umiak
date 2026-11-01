"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { createTeam } from "@/actions/teams";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { attempt } from "@/lib/client-call";
import { teamPath } from "@/lib/team-path";

export function NewTeamForm() {
	const router = useRouter();
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, start] = useTransition();
	const submit = (e: FormEvent) => {
		e.preventDefault();
		setError(null);
		start(async () => {
			const r = await attempt(() => createTeam(name));
			if (r === undefined) return;
			if ("error" in r) setError(r.error.message);
			else router.push(teamPath(r.teamId));
		});
	};
	return (
		<section className="dashboard-card max-w-md space-y-4">
			<div>
				<h1 className="text-xl font-semibold">New team</h1>
				<p className="text-sm text-muted-foreground">
					A shared team for working together. You become its owner and can
					invite others by email.
				</p>
			</div>
			<form onSubmit={submit} className="space-y-3">
				<Input
					aria-label="Team name"
					placeholder="Team name"
					required
					maxLength={64}
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				<Button type="submit" disabled={pending || name.trim() === ""}>
					Create team
				</Button>
			</form>
		</section>
	);
}
