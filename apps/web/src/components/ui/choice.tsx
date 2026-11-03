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
				"disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:outline aria-invalid:outline-destructive",
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
				"disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:outline aria-invalid:outline-destructive",
				className,
			)}
			{...props}
		/>
	);
}
