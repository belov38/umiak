// Shared platform/recipe release selection: exactly two owner-selected channels.
export function releaseChannel(value = "stable") {
	if (!["stable", "edge"].includes(value))
		throw Error("Unknown release channel");
	return value;
}
export function selectRecipeRelease(releases, channel = "stable") {
	releaseChannel(channel);
	return releases
		.filter(
			(r) =>
				!r.draft &&
				(channel === "edge"
					? r.prerelease &&
						/^recipes-\d{8}\.\d+-edge\.\d{8}\.\d+$/.test(r.tag_name)
					: !r.prerelease && /^recipes-\d{8}\.\d+$/.test(r.tag_name)),
		)
		.sort((a, b) =>
			b.tag_name.localeCompare(a.tag_name, undefined, { numeric: true }),
		)[0];
}
// The installer/platform updater owns this setting. Recipes never write it.
export function platformReleaseChannel(state, env = process.env) {
	return releaseChannel(
		state.platform?.channel ?? env.UMIAK_RELEASE_CHANNEL ?? "stable",
	);
}
