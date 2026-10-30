// Sandboxes of the team (S8 §9.4), the team's start page.
import { SandboxList } from "@/features/sandboxes/sandbox-list";

export default async function SandboxesPage({
	params,
}: {
	params: Promise<{ team: string }>;
}) {
	const { team } = await params;
	return <SandboxList teamId={team} />;
}
