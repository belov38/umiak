import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Class names joined, later Tailwind utilities winning (shadcn/ui). */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
