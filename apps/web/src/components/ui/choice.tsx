"use client";
import type { ComponentProps } from "react";
import { useFieldProps } from "@/components/ui/field-context";
import { cn } from "@/lib/utils";

type Props = Omit<ComponentProps<"input">, "type">;
export function Checkbox({ className, ...props }: Props) {
	props = useFieldProps(props);
	return (
		<input
			type="checkbox"
			data-slot="checkbox"
			className={cn(
				"appearance-none inline-grid place-items-center size-4 shrink-0 rounded-none border border-input bg-background align-middle checked:bg-primary checked:border-primary after:content-[''] after:w-2 after:h-1 after:border-l-2 after:border-b-2 after:border-primary-foreground after:-rotate-45 after:opacity-0 checked:after:opacity-100 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:outline aria-invalid:outline-destructive",
				className,
			)}
			{...props}
		/>
	);
}
export function Radio({ className, ...props }: Props) {
	props = useFieldProps(props);
	return (
		<input
			type="radio"
			data-slot="radio"
			className={cn(
				"size-4 shrink-0 accent-primary focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:outline aria-invalid:outline-destructive",
				className,
			)}
			{...props}
		/>
	);
}
