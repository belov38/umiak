// Create sandbox (S8 §9.5). Only the catalog choice (template, size,
// snapshot) can come from the URL; see parsePrefill.
import { CreateSandboxForm } from "@/features/create/create-form";
import { parsePrefill } from "@/lib/create-form";

export default async function NewSandboxPage({
	params,
	searchParams,
}: {
	params: Promise<{ team: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { team } = await params;
	const prefill = parsePrefill(await searchParams);
	return <CreateSandboxForm teamId={team} prefill={prefill} />;
}
