import { describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import nodePath from "node:path";
import { OmpBridgeServer, type OmpBridgeServerOptions } from "../src/adapters/omp-bridge-server.js";

function createSocketPath(): { directory: string; socketPath: string } {
  const directory = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-omp-bridge-server-"));
  return { directory, socketPath: nodePath.join(directory, "bridge.sock") };
}

function createBridgeServer(
  socketPath: string,
  options: Pick<OmpBridgeServerOptions, "onLockOwnerJudged"> = {},
): OmpBridgeServer {
  return new OmpBridgeServer({
    socketPath,
    onBridgeFrame: () => {},
    onControlFrame: () => {},
    ...options,
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

/** A pid that is not running, so a lock file holding it is stale. */
function deadPid(): number {
  for (let pid = 999_000; pid > 900_000; pid -= 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("no unused pid found");
}

describe("OmpBridgeServer socket ownership", () => {
  it("allows only one concurrent starter and preserves its socket", async () => {
    const { directory, socketPath } = createSocketPath();
    const servers = [createBridgeServer(socketPath), createBridgeServer(socketPath)];
    try {
      const results = await Promise.allSettled(servers.map((server) => server.start()));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(fs.existsSync(socketPath)).toBe(true);
      await connect(socketPath);
    } finally {
      for (const server of servers) server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

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

  it("removes a stale lock and starts serving", async () => {
    const { directory, socketPath } = createSocketPath();
    const server = createBridgeServer(socketPath);
    const lockPath = `${socketPath}.lock`;
    try {
      fs.writeFileSync(lockPath, String(Number.MAX_SAFE_INTEGER));
      await server.start();
      await connect(socketPath);
      expect(fs.existsSync(lockPath)).toBe(true);
    } finally {
      server.close();
      expect(fs.existsSync(lockPath)).toBe(false);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  it("takes over a stale pid lock and records its tokenized owner", async () => {
    const { directory, socketPath } = createSocketPath();
    const server = createBridgeServer(socketPath);
    const lockPath = `${socketPath}.lock`;
    try {
      fs.writeFileSync(lockPath, String(deadPid()));
      await server.start();
      await connect(socketPath);
      const owner = fs.readFileSync(lockPath, "utf8");
      expect(owner).toMatch(new RegExp(`^${process.pid}:`));
      expect(owner.slice(`${process.pid}:`.length)).not.toBe("");
    } finally {
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses stale takeover when lock is replaced by a live owner", async () => {
    const { directory, socketPath } = createSocketPath();
    const lockPath = `${socketPath}.lock`;
    let replaced = false;
    const server = createBridgeServer(socketPath, {
      onLockOwnerJudged: () => {
        if (replaced) return;
        replaced = true;
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, `${process.pid}:other-owner`);
      },
    });
    try {
      fs.writeFileSync(lockPath, String(deadPid()));
      await expect(server.start()).rejects.toThrow(
        `Another runner already serves socket ${socketPath}`,
      );
      expect(replaced).toBe(true);
      expect(fs.readFileSync(lockPath, "utf8")).toBe(`${process.pid}:other-owner`);
    } finally {
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves a replacement lock when closing", async () => {
    const { directory, socketPath } = createSocketPath();
    const server = createBridgeServer(socketPath);
    const lockPath = `${socketPath}.lock`;
    try {
      await server.start();
      fs.writeFileSync(lockPath, `${process.pid}:other-owner`);
      server.close();
      expect(fs.readFileSync(lockPath, "utf8")).toBe(`${process.pid}:other-owner`);
    } finally {
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records a pid and non-empty token in its lock", async () => {
    const { directory, socketPath } = createSocketPath();
    const server = createBridgeServer(socketPath);
    try {
      await server.start();
      const owner = fs.readFileSync(`${socketPath}.lock`, "utf8");
      expect(owner).toMatch(new RegExp(`^${process.pid}:`));
      expect(owner.slice(`${process.pid}:`.length)).not.toBe("");
    } finally {
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a live pid lock without removing it", async () => {
    const { directory, socketPath } = createSocketPath();
    const server = createBridgeServer(socketPath);
    const lockPath = `${socketPath}.lock`;
    const owner = `${process.pid}:live-owner`;
    try {
      fs.writeFileSync(lockPath, owner);
      await expect(server.start()).rejects.toThrow(
        `Another runner already serves socket ${socketPath}`,
      );
      expect(fs.readFileSync(lockPath, "utf8")).toBe(owner);
    } finally {
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("takes over a lock file whose owner is gone", async () => {
    const { directory, socketPath } = createSocketPath();
    const server = createBridgeServer(socketPath);
    const lockPath = `${socketPath}.lock`;
    try {
      fs.writeFileSync(lockPath, String(deadPid()));
      await server.start();
      await connect(socketPath);
      const owner = fs.readFileSync(lockPath, "utf8");
      expect(owner).toMatch(new RegExp(`^${process.pid}:`));
      expect(owner.slice(`${process.pid}:`.length)).not.toBe("");
    } finally {
      server.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses an unowned live socket without removing its path", async () => {
    const { directory, socketPath } = createSocketPath();
    const server = createBridgeServer(socketPath);
    const plainServer = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        plainServer.once("error", reject);
        plainServer.listen(socketPath, resolve);
      });
      await expect(server.start()).rejects.toThrow(
        `Another runner already serves socket ${socketPath}`,
      );
      expect(fs.existsSync(socketPath)).toBe(true);
      expect(fs.existsSync(`${socketPath}.lock`)).toBe(false);
      await connect(socketPath);
    } finally {
      server.close();
      await new Promise<void>((resolve) => plainServer.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes its lock file when closed", async () => {
    const { directory, socketPath } = createSocketPath();
    const server = createBridgeServer(socketPath);
    const lockPath = `${socketPath}.lock`;
    try {
      await server.start();
      expect(fs.existsSync(lockPath)).toBe(true);
      server.close();
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      server.close();
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
