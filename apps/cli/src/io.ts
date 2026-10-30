// Reading stdin: the whole stream (`login --key-stdin`), or one line (a
// confirmation prompt).

export async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const c of stream) {
		chunks.push(typeof c === "string" ? Buffer.from(c) : (c as Buffer));
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** One line without its end of line; null at the end of the stream. */
export function readLine(
	stream: NodeJS.ReadableStream,
): Promise<string | null> {
	return new Promise((resolve, reject) => {
		let buf = "";
		const done = () => {
			stream.off("data", onData);
			stream.off("end", onEnd);
			stream.off("error", onError);
			stream.pause();
		};
		const onData = (c: Buffer | string) => {
			buf += typeof c === "string" ? c : c.toString("utf8");
			const i = buf.indexOf("\n");
			if (i < 0) return;
			done();
			resolve(buf.slice(0, i).replace(/\r$/, ""));
		};
		const onEnd = () => {
			done();
			resolve(buf === "" ? null : buf);
		};
		const onError = (err: Error) => {
			done();
			reject(err);
		};
		stream.on("data", onData);
		stream.on("end", onEnd);
		stream.on("error", onError);
	});
}
