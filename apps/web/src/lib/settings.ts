import type { components } from "@umiak/sdk";
export type SettingsSession = components["schemas"]["SettingsSession"];
export async function settingsCall<T>(
	path: string,
	method = "GET",
	body?: unknown,
): Promise<T> {
	const response = await fetch(`/api/v1/settings/${path}`, {
		method,
		credentials: "same-origin",
		headers: { "Content-Type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const result = await response.json();
	if (!response.ok)
		throw new Error(
			result.error?.message ?? `Settings request failed (${response.status})`,
		);
	return result as T;
}
type ActionResult = { ok: true } | { error: { message: string } };
export function setDefaultTeam(defaultTeamId: string): Promise<ActionResult> {
	return settingsCall("account", "PATCH", { defaultTeamId });
}
export function setTemplateEnabled(input: {
	slug: string;
	enabled: boolean;
}): Promise<ActionResult> {
	return settingsCall(`templates/${encodeURIComponent(input.slug)}`, "PATCH", {
		enabled: input.enabled,
	});
}
