import { Link as RouterLink, useRouter } from "@tanstack/react-router";
import type { ComponentProps } from "react";
export default function Link({ href = "", ...props }: ComponentProps<"a">) {
	const router = useRouter({ warn: false });
	if (!router || !href.startsWith("/app")) return <a href={href} {...props} />;
	const { target, ...rest } = props;
	return <RouterLink to={href} {...rest} {...(target ? { target } : {})} />;
}
