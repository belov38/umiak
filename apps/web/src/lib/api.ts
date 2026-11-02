"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// Browser data access of /app (S8 §9.1): @umiak/sdk on the dashboard's own
// origin (`/api`, the oauth2-proxy cookie is the credential, no token) and
// TanStack Query for caching, retries and background refresh.
import { Umiak } from "@umiak/sdk";
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

type UmiakForTeam = (teamId: string) => Umiak;

const UmiakContext = createContext<UmiakForTeam | null>(null);

/**
 * One SDK client per team: every request carries `Umiak-Team: <teamId>`.
 * `""` gives a client without a team (the default team of the user; for
 * requests that are not about a team, like SSH keys).
 */
export function umiakForTeam(teamId: string): Umiak {
	return new Umiak({
		baseUrl: API_BASE_URL,
		session: true,
		...(teamId === "" ? {} : { team: teamId }),
		// Never read UMIAK_* settings in the browser bundle.
		env: {},
		userAgent: "umiak-web",
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

export function UmiakProvider({ children }: { children: ReactNode }) {
	const [queryClient] = useState(makeQueryClient);
	const [clients] = useState(() => new Map<string, Umiak>());
	const forTeam = useCallback<UmiakForTeam>(
		(teamId) => {
			let c = clients.get(teamId);
			if (c === undefined) {
				c = umiakForTeam(teamId);
				clients.set(teamId, c);
			}
			return c;
		},
		[clients],
	);
	return createElement(
		QueryClientProvider,
		{ client: queryClient },
		createElement(UmiakContext.Provider, { value: forTeam }, children),
	);
}

/** The SDK for a team (`team_...`, or "" for none); inside UmiakProvider only. */
export function useUmiak(teamId: string): Umiak {
	const forTeam = useContext(UmiakContext);
	if (forTeam === null) throw new Error("useUmiak outside UmiakProvider");
	return forTeam(teamId);
}
