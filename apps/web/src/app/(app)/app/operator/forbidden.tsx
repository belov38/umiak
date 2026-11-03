import { AccessPage } from "@/components/app/access-page";
import { PageHeader } from "@/components/ui/panel";
// 403 of /app/operator: the section is for platform operators only (S8 §9.10).
export default function OperatorForbidden() {
	return (
		<AccessPage>
			<PageHeader title="Operators only" />
			<p className="mt-2 text-muted-foreground">
				This section is for platform operators. Ask a platform operator if you
				need something blocked, unblocked or cleaned up.
			</p>
			<p className="mt-4">
				<a className="underline" href="/app">
					Go to your default team
				</a>
			</p>
		</AccessPage>
	);
}
