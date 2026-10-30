// Templates and sizes (S7 §13).
import { z } from "@hono/zod-openapi";
import { extensibleEnum } from "../openapi/registry.ts";

export const TemplateSchema = z
	.object({
		slug: z.string().openapi({ example: "linux" }),
		name: z.string(),
		os: extensibleEnum(["linux", "windows"]),
		enabled: z.boolean().openapi({
			description: "Disabled templates are listed for operators only",
		}),
		defaultSize: z.string().openapi({ example: "2gb" }),
		allowedSizes: z.array(z.string()),
		loginUser: z
			.string()
			.openapi({ description: "Guest user of SSH logins", example: "user" }),
		capabilities: z.array(z.string()).openapi({
			description: "What the template supports: exec, files, ssh, desktop",
		}),
		version: z.string().nullable().openapi({
			description: "Version of the active build; null while none is active",
		}),
	})
	.openapi("Template");

export const TemplateListSchema = z
	.object({ data: z.array(TemplateSchema) })
	.openapi("TemplateList");

export const SizeSchema = z
	.object({
		slug: z.string().openapi({ example: "2gb" }),
		vcpu: z.int(),
		memoryMb: z.int(),
	})
	.openapi("Size");

export const SizeListSchema = z
	.object({ data: z.array(SizeSchema) })
	.openapi("SizeList");
