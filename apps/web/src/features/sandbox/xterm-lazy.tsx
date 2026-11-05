import { lazy, Suspense } from "react";
import type { XtermViewProps } from "./xterm";

export type { XtermHandle, XtermViewProps } from "./xterm";

const Terminal = lazy(() => import("./xterm"));
export function XtermView(props: XtermViewProps) {
	return (
		<Suspense fallback={<div>Loading terminal…</div>}>
			<Terminal {...props} />
		</Suspense>
	);
}
