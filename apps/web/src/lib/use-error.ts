"use client";
import { useCallback } from "react";
import { useSingleOwner } from "@/components/app/session-context";
import { describeError } from "./errors";

export function useDescribeError() {
	const singleOwner = useSingleOwner();
	return useCallback(
		(error: unknown) => describeError(error, singleOwner),
		[singleOwner],
	);
}
