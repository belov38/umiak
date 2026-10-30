"use client";
// State, health and block of a sandbox (S8 §9.4): transitional states with
// a spinner and the step of the active operation, `error` red with its
// message, `degraded` yellow with the reason, a lock when blocked.
import type { SandboxData } from "@sbx/sdk";
import { LoaderCircleIcon, LockIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { TRANSITIONAL_STATES } from "@/lib/sandboxes";
import { cn } from "@/lib/utils";

const BLOCK_REASONS: Record<string, string> = {
	operator: "Blocked by a platform operator",
	abuse: "Blocked by a platform operator for abuse",
};

export function blockText(s: Pick<SandboxData, "blockReason">): string {
	return (
		(s.blockReason ? BLOCK_REASONS[s.blockReason] : undefined) ||
		"Blocked by a platform operator"
	);
}

export function BlockLock({ sandbox }: { sandbox: SandboxData }) {
	if (!sandbox.blocked) return null;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					className="inline-flex items-center text-amber-700"
					data-testid="sandbox-blocked"
				>
					<LockIcon className="size-3.5" />
					<span className="sr-only">{blockText(sandbox)}</span>
				</span>
			</TooltipTrigger>
			<TooltipContent className="max-w-64">
				{blockText(sandbox)}: ports and SSH are refused; only reading, stop and
				delete work.
			</TooltipContent>
		</Tooltip>
	);
}

export function StateCell({ sandbox }: { sandbox: SandboxData }) {
	const op = sandbox.activeOperation;
	if (TRANSITIONAL_STATES.has(sandbox.state)) {
		return (
			<div className="flex flex-col gap-0.5" data-testid="sandbox-state">
				<span className="inline-flex items-center gap-1">
					<LoaderCircleIcon className="size-3.5 animate-spin text-muted-foreground" />
					{sandbox.state}
				</span>
				{op && (
					<span className="text-xs text-muted-foreground">
						{op.kind}
						{op.step ? `: ${op.step}` : ""}
					</span>
				)}
			</div>
		);
	}
	if (sandbox.state === "error") {
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					<span data-testid="sandbox-state">
						<Badge variant="destructive">error</Badge>
					</span>
				</TooltipTrigger>
				<TooltipContent className="max-w-72">
					{sandbox.error
						? `${sandbox.error.code}: ${sandbox.error.message}`
						: "The sandbox failed."}
				</TooltipContent>
			</Tooltip>
		);
	}
	return (
		<span
			data-testid="sandbox-state"
			className={cn(sandbox.state === "ready" && "text-emerald-700")}
		>
			{sandbox.state}
		</span>
	);
}

export function HealthCell({ sandbox }: { sandbox: SandboxData }) {
	if (sandbox.health !== "degraded") {
		return <span className="text-muted-foreground">{sandbox.health}</span>;
	}
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span>
					<Badge className="bg-amber-100 text-amber-900">degraded</Badge>
				</span>
			</TooltipTrigger>
			<TooltipContent className="max-w-72">
				{sandbox.healthReason ?? "The agent in the sandbox does not answer."}
			</TooltipContent>
		</Tooltip>
	);
}
