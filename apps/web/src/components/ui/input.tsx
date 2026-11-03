"use client";
import type * as React from "react";
import { useFieldProps } from "@/components/ui/field-context";
import { cn } from "@/lib/utils";

function Input({
	className,
	type,
	size = "default",
	...props
}: Omit<React.ComponentProps<"input">, "size"> & { size?: "default" | "xs" }) {
	props = useFieldProps(props);
	const visuallyHidden = className?.split(/\s+/).includes("sr-only");
	return (
		<input
			type={type}
			data-slot="input"
			className={cn(
				visuallyHidden
					? "sr-only"
					: "w-full min-w-0 rounded-none border border-input bg-background outline-none placeholder:text-muted-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:text-disabled-foreground aria-invalid:border-destructive file:border-0 file:bg-transparent file:text-sm",
				!visuallyHidden &&
					(size === "xs"
						? "h-7 px-2 py-1 text-xs"
						: "h-[var(--control-height)] px-4 py-1 text-sm"),
				className,
			)}
			{...props}
		/>
	);
}

export { Input };
