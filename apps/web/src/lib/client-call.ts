"use client";
// Client-side calls of server actions and the SDK from event handlers and
// transitions. An exception there would reach the error boundary (inside
// startTransition) or become an unhandled rejection (in onClick); `attempt`
// turns it into a toast instead. The error itself is not logged: a request
// body may hold secrets.
import { useCallback } from "react";
import { toast } from "sonner";
import { useSingleOwner } from "@/components/app/session-context";
import { describeError } from "./errors";

/** `fn()`, or undefined after a toast with the text of its error. */
export async function attempt<T>(
	fn: () => Promise<T>,
	singleOwner = false,
): Promise<T | undefined> {
	try {
		return await fn();
	} catch (e) {
		toast.error(describeError(e, singleOwner).message);
		return undefined;
	}
}

/** The same event-handler boundary with the deployment's explicit tenancy. */
export function useAttempt() {
	const singleOwner = useSingleOwner();
	return useCallback(
		<T>(fn: () => Promise<T>) => attempt(fn, singleOwner),
		[singleOwner],
	);
}
