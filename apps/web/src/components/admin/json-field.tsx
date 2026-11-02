"use client";
// JSON fields of the admin as a plain textarea (see JSON_FIELD_COMPONENT in
// @umiak/payload): Payload's Monaco editor loads from a CDN, which the CSP
// blocks. Invalid JSON is shown and not written to the form.
import {
	FieldDescription,
	FieldError,
	FieldLabel,
	useField,
} from "@payloadcms/ui";
import type { JSONFieldClientComponent } from "payload";
import { useEffect, useRef, useState } from "react";

function show(v: unknown): string {
	return v === undefined || v === null ? "" : JSON.stringify(v, null, 2);
}

export const JsonField: JSONFieldClientComponent = ({
	field,
	path,
	readOnly,
}) => {
	const { value, setValue, showError } = useField<unknown>({ path });
	const [text, setText] = useState(() => show(value));
	const [invalid, setInvalid] = useState(false);
	const written = useRef<unknown>(value);

	// A value set from outside (load, reset) replaces the text.
	useEffect(() => {
		if (value !== written.current) {
			written.current = value;
			setText(show(value));
			setInvalid(false);
		}
	}, [value]);

	const disabled = readOnly === true || field.admin?.readOnly === true;
	const description = field.admin?.description;
	return (
		<div
			className={`field-type json${showError || invalid ? " error" : ""}`}
			style={{ marginBottom: "var(--spacing-field, 1.5rem)" }}
		>
			<FieldLabel
				label={field.label ?? field.name}
				path={path}
				required={field.required === true}
			/>
			<FieldError path={path} showError={showError} />
			<textarea
				id={`field-${path.replace(/\./g, "__")}`}
				value={text}
				readOnly={disabled}
				spellCheck={false}
				rows={Math.min(Math.max(text.split("\n").length, 3), 20)}
				style={{
					width: "100%",
					fontFamily: "var(--font-mono, monospace)",
					fontSize: "13px",
					padding: "8px 12px",
					border: `1px solid ${invalid ? "var(--theme-error-500)" : "var(--theme-elevation-150)"}`,
					borderRadius: "var(--style-radius-s, 3px)",
					background: disabled
						? "var(--theme-elevation-100)"
						: "var(--theme-input-bg, var(--theme-elevation-0))",
					color: "var(--theme-elevation-800)",
					resize: "vertical",
				}}
				onChange={(e) => {
					const t = e.target.value;
					setText(t);
					try {
						const v = t.trim() === "" ? null : (JSON.parse(t) as unknown);
						written.current = v;
						setValue(v);
						setInvalid(false);
					} catch {
						setInvalid(true);
					}
				}}
			/>
			{invalid && (
				<div style={{ color: "var(--theme-error-500)", fontSize: "12px" }}>
					Invalid JSON: the last valid value is kept.
				</div>
			)}
			{typeof description === "string" && (
				<FieldDescription description={description} path={path} />
			)}
		</div>
	);
};
