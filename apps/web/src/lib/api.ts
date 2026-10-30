"use client";
// Browser data access of /app (S8 §9.1): @sbx/sdk on the dashboard's own
// origin (`/api`, the oauth2-proxy cookie is the credential, no token) and
// TanStack Query for caching, retries and background refresh.
import { Sbx } from "@sbx/sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createContext,
	createElement,
	type ReactNode,
	useCallback,
	useContext,
	useState,
} from "react";
import { API_BASE_URL } from "./api-base";
import { browserWebSocket } from "./ws";

export { API_BASE_URL };

/**
 * Retry budget of a dashboard request (the SDK default is 60 s): a person
 * is waiting, and TanStack Query refetches anyway. A missing api then shows
 * "API unavailable" within seconds instead of a minute of "Loading…".
 */
export const DASHBOARD_RETRY_BUDGET_MS = 5_000;

type SbxForTeam = (teamId: string) => Sbx;

const SbxContext = createContext<SbxForTeam | null>(null);

/**
 * One SDK client per team: every request carries `Sbx-Team: <teamId>`.
 * `""` gives a client without a team (the default team of the user; for
 * requests that are not about a team, like SSH keys).
 */
export function sbxForTeam(teamId: string): Sbx {
	return new Sbx({
		baseUrl: API_BASE_URL,
		session: true,
		...(teamId === "" ? {} : { team: teamId }),
		// Never read SBX_* settings in the browser bundle.
		env: {},
		userAgent: "sbx-web",
		retryBudgetMs: DASHBOARD_RETRY_BUDGET_MS,
		webSocket: browserWebSocket,
	});
}

export function makeQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			// The SDK already retries what is safe to retry.
			queries: { retry: false, staleTime: 5_000, refetchOnWindowFocus: true },
			mutations: { retry: false },
		},
	});
}

export function SbxProvider({ children }: { children: ReactNode }) {
	const [queryClient] = useState(makeQueryClient);
	const [clients] = useState(() => new Map<string, Sbx>());
	const forTeam = useCallback<SbxForTeam>(
		(teamId) => {
			let c = clients.get(teamId);
			if (c === undefined) {
				c = sbxForTeam(teamId);
				clients.set(teamId, c);
			}
			return c;
		},
		[clients],
	);
	return createElement(
		QueryClientProvider,
		{ client: queryClient },
		createElement(SbxContext.Provider, { value: forTeam }, children),
	);
}

/** The SDK for a team (`team_...`, or "" for none); inside SbxProvider only. */
export function useSbx(teamId: string): Sbx {
	const forTeam = useContext(SbxContext);
	if (forTeam === null) throw new Error("useSbx outside SbxProvider");
	return forTeam(teamId);
}
