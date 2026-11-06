export interface LayerRecipeDescriptor {
	format: "umiak-linux-recipe/v1";
	slug: "linux" | "linux-desktop";
	source: {
		kind: "cloud-image";
		distro: "ubuntu";
		release: "26.04";
		flavor: "minimal";
	};
	disk: { slot: "scsi0"; sizeGb: number };
	hw: Record<string, string>;
	buildVm: { cores: number; memoryMb: number };
	steps: string[];
	bootTimeoutS: number;
	verify: "linux" | "linux-desktop";
	versions: unknown;
	facts: {
		kernel: string;
		systemd: string;
		packages: Record<string, string>;
		tools: Record<string, string | null>;
	};
}
export function parseLayerRecipe(
	bytes: Buffer,
	slug: string,
): LayerRecipeDescriptor;
export function layerRecipeDescriptor(
	recipe: unknown,
	versions: unknown,
	facts: unknown,
): Buffer;
