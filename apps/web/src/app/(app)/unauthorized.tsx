import { AccessPage } from "@/components/app/access-page";
import { PageHeader } from "@/components/ui/panel";
// 401 of /app: the request carried no usable identity (S8 §5.1, §5.3).
export default function Unauthorized() {
	return (
		<AccessPage>
			<PageHeader title="Not signed in" />
			<p className="mt-2 text-muted-foreground">
				The sign-in proxy sent no usable identity for this request. Sign in
				again; if this repeats, ask a platform operator.
			</p>
		</AccessPage>
	);
}
