"use client";
// Error of a TanStack query: "API unavailable" when the API does not answer
// at all (S8 §13: the dashboard keeps working without it), else the text of
// the error. `onRetry` adds a "Try again" button.
import { CloudOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDescribeError } from "@/lib/use-error";

export function QueryError({
	error,
	what,
	onRetry,
}: {
	error: unknown;
	/** "sandboxes", "API keys", ... */
	what: string;
	onRetry?: () => void;
}) {
	const describeError = useDescribeError();
	const v = describeError(error);
	const retry = onRetry && (
		<Button size="xs" variant="outline" onClick={onRetry}>
			Try again
		</Button>
	);
	if (v.apiUnavailable) {
		return (
			<div
				role="alert"
				data-testid="api-unavailable"
				className="flex items-center gap-2 border border-warning/35 bg-warning-tint p-3 text-sm text-warning"
			>
				<CloudOffIcon className="size-4 shrink-0" />
				<p className="flex-1">
					<span className="font-medium">API unavailable.</span> Could not load{" "}
					{what}; try again in a moment.
				</p>
				{retry}
			</div>
		);
	}
	return (
		<div
			role="alert"
			className="flex items-center gap-2 text-sm text-destructive"
		>
			<p>
				Could not load {what}: {v.message}
			</p>
			{retry}
		</div>
	);
}
