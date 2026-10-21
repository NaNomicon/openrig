import { describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import nodePath from "node:path";
import { OMP_BRIDGE_PROTOCOL_VERSION, ompBridgeSocketPath } from "../src/adapters/omp-bridge-protocol.js";
import { OmpTuiRuntimeAdapter } from "../src/adapters/omp-tui-runtime-adapter.js";

function tempStateRoot(): string {
  return fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-omp-tui-delivery-"));
}

function adapterFor(stateRoot: string): OmpTuiRuntimeAdapter {
  return new OmpTuiRuntimeAdapter({
    tmux: {} as never,
    fsOps: {} as never,
    stateRoot,
    runnerEntryPath: "/daemon/pi-runner.js",
    sleep: async () => { /* no waiting in tests */ },
  });
}

/** A stand-in for the runner's bridge socket: it records what arrives. */
async function startSocketServer(stateRoot: string, sessionName: string) {
  const socketPath = ompBridgeSocketPath(nodePath.join(stateRoot, sessionName));
  fs.mkdirSync(nodePath.dirname(socketPath), { recursive: true });
  const frames: Record<string, unknown>[] = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (const line of buffer.split("\n")) {
        if (!line.trim()) continue;
        frames.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
  });
  await new Promise<void>((resolve) => { server.listen(socketPath, resolve); });
  return { socketPath, frames, close: () => { server.close(); } };
}

describe("the omp-tui adapter delivers a Rig message over the bridge socket", () => {
  it("identifies itself as a control client and sends the message as a prompt", async () => {
    const stateRoot = tempStateRoot();
    const sessionName = "seat@rig";
    const socket = await startSocketServer(stateRoot, sessionName);
    const adapter = adapterFor(stateRoot);

    const result = await adapter.deliverMessage(sessionName, "  look at the diff  ");
    expect(result.ok).toBe(true);
    expect(socket.frames[0]).toEqual({ role: "control", protocolVersion: OMP_BRIDGE_PROTOCOL_VERSION });
    expect(socket.frames[1]).toEqual({ type: "prompt", message: "look at the diff" });

    socket.close();
  });

  it("keeps the pane's follow-up convention", async () => {
    const stateRoot = tempStateRoot();
    const sessionName = "seat@rig";
    const socket = await startSocketServer(stateRoot, sessionName);
    const adapter = adapterFor(stateRoot);

    const result = await adapter.deliverMessage(sessionName, "/followup and then summarize");
    expect(result.ok).toBe(true);
    expect(socket.frames[1]).toEqual({ type: "follow_up", message: "and then summarize" });

    socket.close();
  });

  it("reports a failure when the runner's socket is not there", async () => {
    const stateRoot = tempStateRoot();
    const adapter = adapterFor(stateRoot);
    const result = await adapter.deliverMessage("seat@rig", "hello");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
