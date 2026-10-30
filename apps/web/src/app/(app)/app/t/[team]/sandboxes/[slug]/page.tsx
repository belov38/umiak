// The sandbox page (S8 §9.6). Until its tabs arrive (plan task 12) it shows
// the header: name, slug, state and the active operation.
import { SandboxSummary } from "@/features/sandboxes/sandbox-summary";

export default async function SandboxPage({
	params,
}: {
	params: Promise<{ team: string; slug: string }>;
}) {
	const { team, slug } = await params;
	return <SandboxSummary teamId={team} slug={slug} />;
}
