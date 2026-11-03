"use server";
import { runAction } from "@/lib/action-context";
import { setTemplateEnabledImpl } from "@/lib/template-actions";

export async function setTemplateEnabled(args: {
	slug: string;
	enabled: boolean;
}) {
	return runAction((ctx) => setTemplateEnabledImpl(ctx, args));
}
