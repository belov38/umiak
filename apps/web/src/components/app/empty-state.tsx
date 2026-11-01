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
		<div className="dashboard-empty">
			<Icon aria-hidden="true" className="dashboard-empty-icon" />
			<div>{children}</div>
		</div>
	);
}
