"use client";
import type { ComponentProps } from "react";
import { useFieldProps } from "@/components/ui/field-context";
import { cn } from "@/lib/utils";

/** Native semantics for form submission, file metadata and compact toolbars. */
export function NativeSelect({
	className,
	...props
}: ComponentProps<"select">) {
	props = useFieldProps(props);
	return (
		<select
			data-slot="native-select"
			className={cn(
				"h-[var(--control-height)] max-w-full min-w-0 rounded-none border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
				className,
			)}
			{...props}
		/>
	);
}
