/**
 * Test helper: launch an isolated `nats-server` (with JetStream enabled) for
 * the duration of a test suite.
 *
 * Strategy: spawn `docker run nats:2-alpine -js` on a random host port,
 * wait until the «Server is ready» log line appears, then expose the
 * `nats://host:port` URL. On teardown, send `docker stop`.
 *
 * Why Docker: a self-hosted `nats-server` binary is not on PATH in this
 * environment, and bundling a server binary into the Pi repo is a non-
 * starter. Docker is present locally and on CI runners; the alternative
 * (no integration test) violates Konstantin's «не скелеты, всё должно
 * работать» bar.
 *
 * If Docker is unavailable, {@link tryStartNatsServer} returns null and
 * the NATS test file skips the integration suite (still ships unit tests
 * with a mock connection — but see nats-backend.test.ts for how it's
 * wired).
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";

export interface NatsServerHandle {
	url: string;
	stop(): Promise<void>;
}

/** Allocate a random free TCP port by opening + closing a listening socket. */
async function freePort(): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const srv = createServer();
		srv.unref();
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			if (!addr || typeof addr === "string") {
				srv.close();
				reject(new Error("could not determine port"));
				return;
			}
			const port = addr.port;
			srv.close(() => resolve(port));
		});
	});
}

/** Check if Docker is on PATH and the daemon responds. */
function dockerAvailable(): boolean {
	const probe = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
	return probe.status === 0;
}

/**
 * Attempt to start a NATS server via Docker. Returns null if Docker is
 * unavailable or the container fails to come up — caller is expected to
 * skip the NATS integration test in that case.
 */
export async function tryStartNatsServer(): Promise<NatsServerHandle | null> {
	if (!dockerAvailable()) return null;

	const port = await freePort();
	const containerName = `pi-nats-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
	const proc = spawn(
		"docker",
		["run", "--rm", "--name", containerName, "-p", `${port}:4222`, "nats:2-alpine", "-js"],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);

	const ready = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("nats-server did not become ready within 15s")), 15_000);
		const onData = (chunk: Buffer): void => {
			const s = chunk.toString("utf8");
			if (s.includes("Server is ready")) {
				clearTimeout(timer);
				proc.stderr?.off("data", onData);
				proc.stdout?.off("data", onData);
				resolve();
			}
		};
		proc.stderr?.on("data", onData);
		proc.stdout?.on("data", onData);
		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		proc.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`docker exited early (code ${code})`));
		});
	});

	try {
		await ready;
	} catch (err) {
		// Best-effort cleanup if startup failed.
		spawnSync("docker", ["stop", containerName], { stdio: "ignore" });
		try {
			proc.kill("SIGTERM");
		} catch {
			// ignore
		}
		throw err;
	}

	return {
		url: `nats://127.0.0.1:${port}`,
		async stop(): Promise<void> {
			spawnSync("docker", ["stop", containerName], { stdio: "ignore" });
			// docker run --rm already removes the container; nothing else to do.
			await new Promise<void>((resolve) => {
				if (proc.exitCode !== null) {
					resolve();
					return;
				}
				proc.once("exit", () => resolve());
				// Hard kill after 3s if docker stop doesn't bring it down.
				setTimeout(() => {
					try {
						proc.kill("SIGKILL");
					} catch {
						// ignore
					}
					resolve();
				}, 3_000);
			});
		},
	};
}
