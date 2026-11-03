"use client";
import type { ComponentProps } from "react";
import { useFieldProps } from "@/components/ui/field-context";
import { cn } from "@/lib/utils";
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
	props = useFieldProps(props);
	return (
		<textarea
			data-slot="textarea"
			className={cn(
				"min-h-20 w-full min-w-0 rounded-none border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
				className,
			)}
			{...props}
		/>
	);
}
