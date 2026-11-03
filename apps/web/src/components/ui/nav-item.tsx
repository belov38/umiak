import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
export function NavItem({
	className,
	variant = "ghost",
	size = "sm",
	...props
}: ComponentProps<typeof Button>) {
	return (
		<Button
			data-nav-item=""
			variant={variant}
			size={size}
			className={cn(
				"w-full justify-start gap-2 border-0 px-3 aria-[current=page]:bg-secondary aria-[current=page]:text-secondary-foreground",
				variant === "ghost"
					? "text-muted-foreground"
					: "text-secondary-foreground",
				className,
			)}
			{...props}
		/>
	);
}
