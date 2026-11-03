// The sandbox page (S8 §9.6). `<slug>` is a slug or an `sb_…` id (links
// from snapshot sources use the id); the client page reads it as is.
import { Suspense } from "react";
import { LoadingState } from "@/components/ui/feedback";
import { SandboxPage } from "@/features/sandbox/sandbox-page";

export default async function SandboxRoute({
	params,
}: {
	params: Promise<{ team: string; slug: string }>;
}) {
	const { team, slug } = await params;
	return (
		// useSearchParams (the tab) needs a Suspense boundary.
		<Suspense fallback={<LoadingState />}>
			<SandboxPage teamId={team} sandboxRef={slug} />
		</Suspense>
	);
}
