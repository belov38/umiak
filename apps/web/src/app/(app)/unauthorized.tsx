// 401 of /app: the request carried no usable identity (S8 §5.1, §5.3).
export default function Unauthorized() {
	return (
		<main className="mx-auto max-w-xl p-8">
			<h1 className="text-xl font-semibold">Not signed in</h1>
			<p className="mt-2 text-muted-foreground">
				The sign-in proxy sent no usable identity for this request. Sign in
				again; if this repeats, ask a platform operator.
			</p>
		</main>
	);
}
