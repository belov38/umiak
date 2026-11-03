import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { Field } from "@/components/app/form-dialog";
import { Select, SelectTrigger, SelectValue } from "@/components/ui/select";
import { NoteInput } from "@/features/operator/block-dialog";

test("Field associates an error with a nested custom textarea", () => {
	const html = renderToStaticMarkup(
		<Field label="Note" error="Too long">
			<NoteInput value="note" onChange={() => {}} />
		</Field>,
	);
	const control = html.match(/<textarea[^>]+>/)?.[0] ?? "";
	expect(control).toContain('aria-invalid="true"');
	const message = control.match(/aria-describedby="([^"]+)"/)?.[1];
	expect(message).toBeTruthy();
	expect(html).toContain(`id="${message}" role="alert"`);
});
test("Field sends accessibility state to the Radix trigger", () => {
	const html = renderToStaticMarkup(
		<Field label="Reason" error="Choose reason">
			<Select>
				<SelectTrigger>
					<SelectValue />
				</SelectTrigger>
			</Select>
		</Field>,
	);
	const control = html.match(/<button[^>]+>/)?.[0] ?? "";
	expect(control).toContain('aria-invalid="true"');
	expect(control).toContain("aria-describedby=");
});
