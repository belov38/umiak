// Iteration over the cursor pages of the list routes (S7 §5.6):
// `{data, nextCursor}`; nextCursor null on the last page.

export interface Page<T> {
	data: T[];
	nextCursor?: string | null;
}

/**
 * Every item of every page, fetched lazily: the next page is requested only
 * when the loop reaches the end of the current one.
 */
export function paginate<T>(
	fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
): AsyncIterable<T> {
	return {
		async *[Symbol.asyncIterator]() {
			let cursor: string | undefined;
			for (;;) {
				const page = await fetchPage(cursor);
				yield* page.data;
				if (page.nextCursor === null || page.nextCursor === undefined) return;
				cursor = page.nextCursor;
			}
		},
	};
}
