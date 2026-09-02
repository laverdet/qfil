/**
 * `JSON.rawJSON` and the reviver's `context.source` — V8's JSON.parse source text access, in Node
 * since 21 — which TypeScript's libraries do not declare yet.
 */
interface RawJSON {
	readonly rawJSON: string;
}

/* eslint-disable @typescript-eslint/method-signature-style -- method signatures merge with the library's as overloads; properties would not */
interface JSON {
	/** A JSON primitive written verbatim by `stringify`, however it is spelled. */
	rawJSON(text: string): RawJSON;
	isRawJSON(value: unknown): value is RawJSON;
	parse(text: string, reviver?: (this: unknown, key: string, value: unknown, context: { readonly source?: string }) => unknown): unknown;
}
