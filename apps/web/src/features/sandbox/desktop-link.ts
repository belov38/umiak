import type { Sandbox } from "@umiak/sdk";

/** A link is single-use: keep it outside the shared query cache. */
export async function fetchDesktopLink(
	link: Sandbox["desktop"]["link"],
	signal: AbortSignal,
): ReturnType<Sandbox["desktop"]["link"]> {
	for (;;) {
		signal.throwIfAborted();
		try {
			return await link({}, { signal });
		} catch (error) {
			if (
				!(
					error &&
					typeof error === "object" &&
					"code" in error &&
					error.code === "desktop_not_ready"
				)
			)
				throw error;
			await new Promise<void>((resolve, reject) => {
				const cancel = () => {
					clearTimeout(timer);
					reject(signal.reason);
				};
				const timer = setTimeout(() => {
					signal.removeEventListener("abort", cancel);
					resolve();
				}, 2000);
				signal.addEventListener("abort", cancel, { once: true });
				if (signal.aborted) cancel();
			});
		}
	}
}
