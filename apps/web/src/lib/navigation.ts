import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
export function usePathname() {
	return useLocation({ select: (location) => location.pathname });
}
export function useSearchParams() {
	const search = useLocation({ select: (location) => location.searchStr });
	return useMemo(() => new URLSearchParams(search), [search]);
}
export function useAppNavigation() {
	const navigate = useNavigate();
	const client = useQueryClient();
	const move = (path: string, replace = false) => {
		const url = new URL(path, window.location.origin);
		void navigate({
			to: url.pathname,
			search: Object.fromEntries(url.searchParams),
			replace,
		});
	};
	return {
		go: (path: string) => move(path),
		replace: (path: string, _options?: { scroll?: boolean }) =>
			move(path, true),
		refresh: () => {
			void client.invalidateQueries();
		},
	};
}
