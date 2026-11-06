/** Dev-only capture transport. Credentials are deliberately unsupported. */
export function validateBuildAptProxy(
	value: string | undefined,
): string | undefined {
	if (value === undefined || value === "") return undefined;
	try {
		const url = new URL(value);
		if (
			value !== value.trim() ||
			/[\s"\\]/.test(value) ||
			url.protocol !== "http:" ||
			!url.hostname ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			!["", "/"].includes(url.pathname)
		)
			throw Error();
		return url.origin;
	} catch {
		throw Error(
			"UMIAK_BUILD_APT_PROXY must be an HTTP origin without credentials, path, query or fragment",
		);
	}
}
