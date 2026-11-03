"use client";
import type { ComponentProps } from "react";
import { useFieldProps } from "@/components/ui/field-context";
import { cn } from "@/lib/utils";

/** Native semantics for form submission, file metadata and compact toolbars. */
export function NativeSelect({
	className,
	size = "default",
	...props
}: Omit<ComponentProps<"select">, "size"> & {
	size?: "default" | "sm" | "xs";
}) {
	props = useFieldProps(props);
	return (
		<select
			data-slot="native-select"
			className={cn(
				"max-w-full min-w-0 rounded-none border border-input bg-background text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
				size === "xs"
					? "h-7 px-1 text-xs"
					: size === "sm"
						? "h-10 px-2 text-sm"
						: "h-[var(--control-height)] px-3 text-sm",
				className,
			)}
			{...props}
		/>
	);
}
