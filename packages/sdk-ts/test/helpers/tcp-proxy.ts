// A loopback TCP proxy standing in for the load balancer in front of the api
// instances: new client connections go to the current target port; `drop()`
// breaks every live connection (client and upstream side) at once;
// `cutNextAnswer()` breaks the connection that gets the next bytes from
// upstream, before they reach the client (the server did the work, the
// client never learns).
import { connect, createServer, type Server, type Socket } from "node:net";
import { Transform } from "node:stream";

export interface TcpProxy {
	/** Port clients connect to (127.0.0.1). */
	port: number;
	/** New connections go to this port; live ones stay where they are. */
	target(port: number): void;
	/** Destroys every live connection; returns how many there were. */
	drop(): number;
	/** The next upstream bytes on any connection break it instead of passing. */
	cutNextAnswer(): void;
	/** Live client connections. */
	readonly size: number;
	close(): Promise<void>;
}

export async function startTcpProxy(targetPort: number): Promise<TcpProxy> {
	let target = targetPort;
	let cutArmed = false;
	const pairs = new Set<{ client: Socket; upstream: Socket }>();
	const server: Server = createServer((client) => {
		const upstream = connect(target, "127.0.0.1");
		const pair = { client, upstream };
		pairs.add(pair);
		const end = () => {
			pairs.delete(pair);
			client.destroy();
			upstream.destroy();
		};
		const answers = new Transform({
			transform(chunk, _enc, cb) {
				if (cutArmed) {
					cutArmed = false;
					end();
					cb();
					return;
				}
				cb(null, chunk);
			},
		});
		client.on("error", end).on("close", end);
		upstream.on("error", end).on("close", end);
		answers.on("error", end);
		client.pipe(upstream);
		upstream.pipe(answers).pipe(client);
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("proxy has no port");
	}
	const dropAll = () => {
		const n = pairs.size;
		for (const p of [...pairs]) {
			p.client.destroy();
			p.upstream.destroy();
		}
		pairs.clear();
		return n;
	};
	return {
		port: address.port,
		target(port) {
			target = port;
		},
		drop: dropAll,
		cutNextAnswer() {
			cutArmed = true;
		},
		get size() {
			return pairs.size;
		},
		close() {
			dropAll();
			return new Promise((r) => server.close(() => r()));
		},
	};
}
