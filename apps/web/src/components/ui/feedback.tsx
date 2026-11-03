import { LoaderCircleIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
export function CodeBlock({ className, ...props }: ComponentProps<"pre">) {
	return (
		<pre
			data-slot="code-block"
			className={cn(
				"max-w-full overflow-x-auto rounded-none bg-muted p-4 font-mono text-xs",
				className,
			)}
			{...props}
		/>
	);
}
export function LoadingState() {
	return (
		<p
			role="status"
			className="flex items-center gap-2 text-sm text-muted-foreground"
		>
			<LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" />
			Loading…
		</p>
	);
}

export function StatusDot({ className }: { className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn("size-1.5 rounded-full", className)}
		/>
	);
}
