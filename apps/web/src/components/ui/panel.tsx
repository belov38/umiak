import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
export function Panel({ className, ...props }: ComponentProps<"section">) {
	return (
		<section
			data-slot="panel"
			className={cn(
				"min-w-0 rounded-none border border-border bg-card p-5 text-card-foreground",
				className,
			)}
			{...props}
		/>
	);
}
export function ActionBar({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="action-bar"
			className={cn("flex flex-wrap items-center gap-2", className)}
			{...props}
		/>
	);
}
export function PageHeader({
	title,
	meta,
	action,
	className,
	compact = false,
	...props
}: Omit<ComponentProps<"header">, "title"> & {
	title: ReactNode;
	meta?: ReactNode;
	action?: ReactNode;
	compact?: boolean;
}) {
	return (
		<header
			data-slot="page-header"
			className={cn(
				"flex min-w-0 flex-col items-start gap-x-4 gap-y-2 sm:flex-row sm:flex-wrap sm:items-center",
				className,
			)}
			{...props}
		>
			<h1
				className={cn(
					"min-w-0 shrink-0",
					compact && "sandbox-detail-heading flex items-center gap-2",
				)}
			>
				{title}
			</h1>
			{meta}
			<div className="flex flex-wrap items-center gap-2 sm:ml-auto">
				{action}
			</div>
		</header>
	);
}
