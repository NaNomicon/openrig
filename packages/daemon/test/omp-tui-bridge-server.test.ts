import { describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import nodePath from "node:path";
import { OmpBridgeServer } from "../src/adapters/omp-bridge-server.js";

function createSocketPath(): { directory: string; socketPath: string } {
  const directory = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-omp-bridge-server-"));
  return { directory, socketPath: nodePath.join(directory, "bridge.sock") };
}

function createBridgeServer(socketPath: string): OmpBridgeServer {
  return new OmpBridgeServer({
    socketPath,
    onBridgeFrame: () => {},
    onControlFrame: () => {},
  });
}

function connect(socketPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}

describe("OmpBridgeServer socket ownership", () => {
  it("refuses a live socket owner without disrupting its control connections", async () => {
    const { directory, socketPath } = createSocketPath();
    const owner = createBridgeServer(socketPath);
    const contender = createBridgeServer(socketPath);
    try {
      await owner.start();
      await expect(contender.start()).rejects.toThrow(
        `Another runner already serves socket ${socketPath}`,
      );
      await connect(socketPath);
    } finally {
      owner.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes a stale socket path and starts serving", async () => {
    const { directory, socketPath } = createSocketPath();
    const server = createBridgeServer(socketPath);
    try {
      fs.writeFileSync(socketPath, "stale socket entry");
      await server.start();
      await connect(socketPath);
    } finally {
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
