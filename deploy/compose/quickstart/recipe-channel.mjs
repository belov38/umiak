import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	platformReleaseChannel,
	selectRecipeRelease,
} from "../release-channel.mjs";
import { cacheRecipeBundle, verifyRecipeBundle } from "./recipe-bundle.mjs";
export function idleForRecipeBuild(node) {
	return (
		node.state === "active" &&
		!node.buildJobId &&
		Number(node.running || 0) === 0
	);
}
export class RecipeChannel {
	constructor({ jobs, secretsDir, fetcher = fetch, rollout }) {
		Object.assign(this, { jobs, secretsDir, fetcher, rollout });
	}
	async update(fn) {
		await this.jobs.update((s) => {
			s.recipeChannel ||= { enabled: true, auto: true, intervalHours: 24 };
			fn(s.recipeChannel);
		});
	}
	async settings(input) {
		await this.update((c) => {
			for (const key of ["enabled", "auto"])
				if (typeof input[key] === "boolean") c[key] = input[key];
			if (input.intervalHours !== undefined) {
				if (
					!Number.isInteger(input.intervalHours) ||
					input.intervalHours < 1 ||
					input.intervalHours > 168
				)
					throw Error("Interval must be 1–168 hours");
				c.intervalHours = input.intervalHours;
			}
		});
	}
	async download(url, max = 32 * 1024 * 1024, accept) {
		const response = await this.fetcher(url, {
			signal: AbortSignal.timeout(60000),
			headers: {
				Accept: accept || "application/octet-stream",
				...(process.env.UMIAK_RECIPE_GITHUB_TOKEN
					? { Authorization: `Bearer ${process.env.UMIAK_RECIPE_GITHUB_TOKEN}` }
					: {}),
			},
		});
		if (!response.ok) throw Error(`Recipe channel HTTP ${response.status}`);
		const chunks = [];
		let size = 0;
		for await (const chunk of response.body) {
			size += chunk.length;
			if (size > max) throw Error("Recipe channel asset too large");
			chunks.push(chunk);
		}
		return Buffer.concat(chunks);
	}
	async tick(force = false) {
		if (this.busy) return;
		this.busy = true;
		try {
			await this.update(() => {});
			let state = await this.jobs.store.read();
			let c = state.recipeChannel;
			const selectedChannel = platformReleaseChannel(state);
			if (!c.enabled) return;
			if (
				force ||
				c.checkedChannel !== selectedChannel ||
				!c.checkedAt ||
				Date.now() - Date.parse(c.checkedAt) >= c.intervalHours * 3600000
			) {
				await this.update((c) => {
					c.checkedAt = new Date().toISOString();
					c.checkedChannel = selectedChannel;
				});
				const keys = await publisherKeys(this.secretsDir);
				if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string"))
					throw Error("Invalid publisher keys");
				let release;
				for (let page = 1; page <= 10; page++) {
					const releases = JSON.parse(
						(
							await this.download(
								`https://api.github.com/repos/belov38/umiak/releases?per_page=100&page=${page}`,
								2 * 1024 * 1024,
								"application/vnd.github+json",
							)
						).toString(),
					);
					release = selectRecipeRelease(releases, selectedChannel);
					if (release || releases.length < 100) break;
				}
				if (!release) throw Error("No recipe release published");
				const asset = async (name) => {
					const a = release.assets.find((a) => a.name === name);
					if (
						!a?.url.startsWith(
							"https://api.github.com/repos/belov38/umiak/releases/assets/",
						)
					)
						throw Error(`Missing recipe asset ${name}`);
					return this.download(a.url);
				};
				const [archive, sums, signature] = await Promise.all([
					asset("recipes.tar"),
					asset("SHA256SUMS"),
					asset("SHA256SUMS.sig"),
				]);
				const verified = verifyRecipeBundle({
					archive,
					sums,
					signature,
					keys,
					platform: process.env.UMIAK_PLATFORM_VERSION || "0.1.0",
					agent: process.env.UMIAK_AGENT_VERSION || "0.1.0",
				});
				if (`recipes-${verified.manifest.version}` !== release.tag_name)
					throw Error("Recipe release identity mismatch");
				const directory = await cacheRecipeBundle(
					verified,
					join(this.secretsDir, "recipe-cache"),
				);
				await this.update((c) => {
					c.following = selectedChannel;
					c.available = { ...verified.manifest, directory };
					c.error = null;
				});
			}
			state = await this.jobs.store.read();
			c = state.recipeChannel;
			if (
				c.enabled &&
				c.following === platformReleaseChannel(state) &&
				c.auto &&
				c.available &&
				!c.error &&
				state.buildJob?.status !== "running" &&
				!state.buildQueue?.active
			)
				await this.rollout(c.available, state);
		} catch (error) {
			await this.update((c) => {
				c.error = error.message;
			});
		} finally {
			this.busy = false;
		}
	}
}

// The official publisher key ships with the platform release (same trust root as
// the images); an owner-provisioned list in the secrets dir overrides it.
const BAKED_PUBLISHER_KEY = new URL(
	"../../../infra/templates/keys/recipe-publisher.pub",
	import.meta.url,
);
export async function publisherKeys(secretsDir) {
	try {
		return JSON.parse(
			await readFile(join(secretsDir, "recipe-publisher-keys.json"), "utf8"),
		);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	return [await readFile(BAKED_PUBLISHER_KEY, "utf8")];
}
