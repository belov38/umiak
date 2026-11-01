import type * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
	return (
		<input
			type={type}
			data-slot="input"
			className={cn(
				"h-[var(--control-height)] w-full min-w-0 rounded-none border border-input bg-background px-4 py-1 text-sm outline-none placeholder:text-[#9e9e9e] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:text-[#9e9e9e] aria-invalid:border-destructive file:border-0 file:bg-transparent file:text-sm",
				className,
			)}
			{...props}
		/>
	);
}

export { Input };
