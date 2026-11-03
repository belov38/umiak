"use client";
import type { ComponentProps } from "react";
import { useFieldProps } from "@/components/ui/field-context";
import { cn } from "@/lib/utils";
export function Textarea({
	className,
	size = "default",
	...props
}: ComponentProps<"textarea"> & { size?: "default" | "sm" | "xs" }) {
	props = useFieldProps(props);
	return (
		<textarea
			data-slot="textarea"
			className={cn(
				"w-full min-w-0 rounded-none border border-input bg-background placeholder:text-muted-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
				size === "xs"
					? "min-h-14 px-2 py-1.5 text-xs"
					: size === "sm"
						? "min-h-16 px-2 py-1.5 text-sm"
						: "min-h-20 px-3 py-2 text-sm",
				className,
			)}
			{...props}
		/>
	);
}
