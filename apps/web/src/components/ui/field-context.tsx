"use client";
import type { AriaAttributes } from "react";
import { createContext, useContext } from "react";
export const FieldContext = createContext<{
	id: string;
	messageId?: string | undefined;
	invalid: boolean;
	required: boolean;
} | null>(null);
type FieldAttributes = {
	id?: string | undefined;
	required?: boolean | undefined;
	"aria-describedby"?: string | undefined;
	"aria-invalid"?: AriaAttributes["aria-invalid"];
};
/** Applied by actual DOM controls, including controls inside custom wrappers. */
export function useFieldProps<T extends FieldAttributes>(props: T): T {
	const field = useContext(FieldContext);
	if (!field) return props;
	return {
		...props,
		id: props.id ?? field.id,
		required: field.required || props.required,
		"aria-invalid": field.invalid || props["aria-invalid"],
		"aria-describedby":
			[props["aria-describedby"], field.messageId].filter(Boolean).join(" ") ||
			undefined,
	};
}
