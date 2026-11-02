// A ConfigReader whose platform defaults a test may change between requests
// (the api reads them on every request, S8 C7).
import type { ConfigReader, PlatformDefaults } from "@umiak/config";

export function mutableDefaults(base: ConfigReader): {
	config: ConfigReader;
	set(d: Partial<PlatformDefaults>): void;
} {
	let over: Partial<PlatformDefaults> = {};
	const config = new Proxy(base, {
		get(t, k) {
			if (k === "defaults") {
				return async () => ({ ...(await t.defaults()), ...over });
			}
			const v = Reflect.get(t, k);
			return typeof v === "function" ? v.bind(t) : v;
		},
	}) as ConfigReader;
	return {
		config,
		set(d) {
			over = { ...over, ...d };
		},
	};
}
