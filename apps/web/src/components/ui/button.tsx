import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
	"group/button inline-flex shrink-0 items-center justify-center rounded-none border border-transparent text-sm font-normal whitespace-nowrap transition-colors duration-[120ms] outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:border-transparent disabled:bg-muted disabled:text-disabled-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[18px]",
	{
		variants: {
			variant: {
				default:
					"bg-primary text-primary-foreground hover:bg-[var(--primary-hover)]",
				outline: "border-input bg-background text-foreground hover:bg-muted",
				secondary:
					"bg-secondary text-secondary-foreground hover:bg-secondary/80",
				ghost: "bg-transparent hover:bg-muted active:bg-border",
				destructive:
					"bg-transparent text-destructive hover:bg-[var(--destructive-tint)]",
				link: "text-link underline underline-offset-4 hover:decoration-2",
			},
			size: {
				default: "h-[var(--control-height)] gap-2 px-4",
				xs: "h-7 gap-1 px-2 text-xs",
				sm: "h-10 gap-2 px-3",
				lg: "h-12 gap-2 px-4",
				icon: "size-10",
				"icon-xs": "size-7 [&_svg:not([class*='size-'])]:size-3.5",
				"icon-sm": "size-8",
				"icon-lg": "size-12",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

function Button({
	className,
	variant = "default",
	size = "default",
	asChild = false,
	...props
}: React.ComponentProps<"button"> &
	VariantProps<typeof buttonVariants> & {
		asChild?: boolean;
	}) {
	const Comp = asChild ? Slot.Root : "button";

	return (
		<Comp
			data-slot="button"
			data-variant={variant}
			data-size={size}
			className={cn(buttonVariants({ variant, size, className }))}
			{...props}
		/>
	);
}

export { Button, buttonVariants };
