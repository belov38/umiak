// 403 of /app/operator: the section is for platform operators only (S8 §9.10).
export default function OperatorForbidden() {
	return (
		<main className="mx-auto max-w-xl p-8">
			<h1 className="text-xl font-semibold">Operators only</h1>
			<p className="mt-2 text-muted-foreground">
				This section is for platform operators. Ask a platform operator if you
				need something blocked, unblocked or cleaned up.
			</p>
			<p className="mt-4">
				<a className="underline" href="/app">
					Go to your default team
				</a>
			</p>
		</main>
	);
}
