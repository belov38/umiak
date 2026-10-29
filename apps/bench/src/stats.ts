export interface Summary {
	n: number;
	median?: number;
	p95?: number;
	min?: number;
	max?: number;
}

/** median, nearest-rank p95, min, max. With n < 20, p95 equals max. */
export function summarize(samples: number[]): Summary {
	const xs = [...samples].sort((a, b) => a - b);
	const n = xs.length;
	if (n === 0) return { n: 0 };
	const at = (i: number) => xs[i] as number;
	const median =
		n % 2 === 1 ? at((n - 1) / 2) : (at(n / 2 - 1) + at(n / 2)) / 2;
	return {
		n,
		median,
		p95: at(Math.ceil(0.95 * n) - 1),
		min: at(0),
		max: at(n - 1),
	};
}
