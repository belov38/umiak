// The Payload admin at /admin (from Payload's Next.js template).

import config from "@payload-config";
import { generatePageMetadata, RootPage } from "@payloadcms/next/views";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDeploymentMeta } from "@/lib/deployment-meta";
import { importMap } from "../importMap.js";

type Args = {
	params: Promise<{ segments: string[] }>;
	searchParams: Promise<{ [key: string]: string | string[] }>;
};

export const generateMetadata = ({
	params,
	searchParams,
}: Args): Promise<Metadata> =>
	generatePageMetadata({ config, params, searchParams });

export default async function Page({ params, searchParams }: Args) {
	if ((await getDeploymentMeta()).tenancy === "single")
		redirect("/app/settings");
	return RootPage({ config, params, searchParams, importMap });
}
