/** Headers accepted by the trusted owner ingress boundary. */
export type HeaderSource =
	| Headers
	| Record<string, string | string[] | undefined>;
