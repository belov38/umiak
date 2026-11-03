import { ArchiveIcon, BoxIcon, KeyRoundIcon, LayersIcon } from "lucide-react";
import type { ReactNode } from "react";

const icons = {
	sandboxes: BoxIcon,
	snapshots: ArchiveIcon,
	keys: KeyRoundIcon,
	environments: LayersIcon,
};

export function EmptyState({
	kind,
	children,
}: {
	kind: keyof typeof icons;
	children: ReactNode;
}) {
	const Icon = icons[kind];
	return (
		<div
			data-slot="empty-state"
			className="flex min-h-70 flex-col items-center justify-center gap-4 px-4 py-12 text-center text-xs text-muted-foreground"
		>
			<Icon
				aria-hidden="true"
				className="size-24 text-muted-foreground stroke-[0.75]"
			/>
			<div>{children}</div>
		</div>
	);
}
