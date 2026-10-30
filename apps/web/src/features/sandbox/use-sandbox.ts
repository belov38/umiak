"use client";
// The sandbox of the page, live (S8 §9.6): a plain GET every 10 s (health
// and activity do not wake a long-poll) and the long-poll loop of live.ts.
// The page references the sandbox by slug or `sb_…` id (snapshot sources
// link by id); after the first answer everything uses the id, so a rename
// does not break the page.
import type { Sandbox, SandboxData } from "@sbx/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { useSbx } from "@/lib/api";
import { POLL_RETRY_BUDGET_MS } from "@/lib/sandboxes";
import {
	LIVE_POLL_MS,
	type LiveLoop,
	LONG_POLL_SECONDS,
	startLiveLoop,
} from "./live";

/** A long-poll request is given up this long after it started. */
const LONG_POLL_TIMEOUT_MS = (LONG_POLL_SECONDS + 15) * 1000;

export function sandboxQueryKey(teamId: string, ref: string) {
	return ["sandboxes", teamId, "one", ref] as const;
}

export interface LiveSandbox {
	data: SandboxData | undefined;
	/** SDK handle (files, ports, commands, PTY); bound to the id. */
	handle: Sandbox | undefined;
	error: unknown;
	isPending: boolean;
	refetch: () => Promise<unknown>;
	/** Await this operation (started by a button) in the live loop. */
	track: (operationId: string) => void;
}

export function useLiveSandbox(teamId: string, ref: string): LiveSandbox {
	const sbx = useSbx(teamId);
	const queryClient = useQueryClient();
	const key = sandboxQueryKey(teamId, ref);
	const handles = useRef(new Map<string, Sandbox>());

	const q = useQuery({
		queryKey: key,
		queryFn: async ({ signal }) => {
			const sb = await sbx.sandboxes.get(ref, {
				signal,
				retryBudgetMs: POLL_RETRY_BUDGET_MS,
			});
			if (!handles.current.has(sb.id)) handles.current.set(sb.id, sb);
			return sb.data;
		},
		refetchInterval: LIVE_POLL_MS,
		refetchIntervalInBackground: false,
	});

	const id = q.data?.id;
	const stateRef = useRef<string | undefined>(undefined);
	stateRef.current = q.data?.state;
	const loopRef = useRef<LiveLoop | null>(null);
	const pending = useRef<string[]>([]);

	useEffect(() => {
		if (id === undefined) return;
		const ac = new AbortController();
		const queryKey = sandboxQueryKey(teamId, ref);
		const loop = startLiveLoop(
			{
				state: () => stateRef.current,
				longPoll: async (waitFor, signal) => {
					const { data } = await sbx.raw.GET("/v1/sandboxes/{sandbox}", {
						params: {
							path: { sandbox: id },
							query: { waitFor, waitSeconds: LONG_POLL_SECONDS },
						},
						signal,
						timeoutMs: LONG_POLL_TIMEOUT_MS,
					});
					stateRef.current = data.state;
					queryClient.setQueryData(queryKey, data);
				},
				waitOperation: async (opId, signal) => {
					await sbx.waitForOperation(opId, { signal });
					await queryClient.invalidateQueries({ queryKey });
				},
			},
			ac.signal,
		);
		loopRef.current = loop;
		for (const op of pending.current.splice(0)) loop.track(op);
		return () => {
			ac.abort();
			loopRef.current = null;
		};
	}, [id, sbx, queryClient, teamId, ref]);

	const track = useCallback((operationId: string) => {
		if (loopRef.current === null) pending.current.push(operationId);
		else loopRef.current.track(operationId);
	}, []);

	return {
		data: q.data,
		handle: id === undefined ? undefined : handles.current.get(id),
		error: q.error,
		isPending: q.isPending,
		refetch: q.refetch,
		track,
	};
}
