// The runner-side half of the OpenRig ↔ OMP native-TUI bridge.
//
// The seat runner owns one Unix socket. Two kinds of client connect to it:
//
//   role "bridge"  — the OMP-side extension running inside OMP. It reports
//                    OMP's session events and applies the commands relayed
//                    to it (a Rig message, a steer, an abort, a state read).
//   role "control" — the daemon's message writer. It sends one command frame
//                    per Rig message.
//
// The runner routes frames between them and never interprets OMP's event
// vocabulary itself: bridge frames go into the same event path the RPC child
// used, so activity, session identity and the readiness sidecar keep working
// unchanged.

import fs from "node:fs";
import net from "node:net";
import {
  OMP_BRIDGE_PROTOCOL_VERSION,
  createBridgeFrameDecoder,
  encodeBridgeFrame,
  isBridgeHandshake,
  type OmpBridgeHandshake,
} from "./omp-bridge-protocol.js";

export interface OmpBridgeServerOptions {
  /** Absolute path of the socket file to serve. */
  socketPath: string;
  /** A frame from the OMP-side bridge (an OMP event or a command reply). */
  onBridgeFrame: (frame: Record<string, unknown>) => void;
  /** A command frame from a control client (the daemon's message writer). */
  onControlFrame: (frame: Record<string, unknown>) => void;
  /** The bridge connected and identified itself. */
  onBridgeReady?: (handshake: OmpBridgeHandshake) => void;
  /** Diagnostics for the seat log. */
  onLog?: (line: string) => void;
}

/** Commands queued for the bridge while it has not connected yet. */
const MAX_PENDING_COMMANDS = 64;

/**
 * The bridge socket server. One instance per seat, owned by the runner.
 */
export class OmpBridgeServer {
  private server: net.Server | null = null;
  private bridgeSocket: net.Socket | null = null;
  private readonly pending: string[] = [];

  constructor(private readonly opts: OmpBridgeServerOptions) {}

  /** Whether the OMP-side bridge has connected. */
  get bridgeConnected(): boolean {
    return this.bridgeSocket !== null;
  }

  /** Commands waiting for the bridge to connect. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Start serving. Replaces a stale socket file left by a previous launch. */
  async start(): Promise<void> {
    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    try {
      fs.rmSync(this.opts.socketPath, { force: true });
    } catch { /* a stale socket that cannot be removed fails the listen below */ }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.opts.socketPath);
    });
    // The socket carries seat traffic: keep it owner-only.
    try {
      fs.chmodSync(this.opts.socketPath, 0o600);
    } catch { /* best effort — the seat directory already restricts access */ }
  }

  /** Stop serving and remove the socket file. */
  close(): void {
    this.bridgeSocket?.end();
    this.bridgeSocket = null;
    this.server?.close();
    this.server = null;
    try {
      fs.rmSync(this.opts.socketPath, { force: true });
    } catch { /* already gone */ }
  }

  /**
   * Send one frame to the OMP-side bridge. While the bridge is still
   * starting, the frame is queued and flushed on connect.
   */
  sendToBridge(frame: Record<string, unknown>): void {
    const payload = encodeBridgeFrame(frame);
    if (!this.bridgeSocket) {
      if (this.pending.length < MAX_PENDING_COMMANDS) this.pending.push(payload);
      return;
    }
    this.writeToBridge(payload);
  }

  private writeToBridge(payload: string): void {
    const socket = this.bridgeSocket;
    if (!socket) return;
    try {
      socket.write(payload);
    } catch (error) {
      this.opts.onLog?.(`[omp-bridge] write to bridge failed: ${(error as Error).message}`);
    }
  }

  private accept(socket: net.Socket): void {
    let role: "bridge" | "control" | null = null;
    const decoder = createBridgeFrameDecoder((frame) => {
      if (role === null) {
        if (!isBridgeHandshake(frame)) {
          this.opts.onLog?.("[omp-bridge] ignored a connection that did not handshake");
          socket.end();
          return;
        }
        role = frame.role;
        if (role === "bridge") {
          this.bridgeSocket = socket;
          socket.on("close", () => {
            if (this.bridgeSocket === socket) this.bridgeSocket = null;
          });
          this.opts.onBridgeReady?.(frame);
          this.flushPending();
        }
        return;
      }
      if (role === "bridge") {
        this.opts.onBridgeFrame(frame);
        return;
      }
      this.opts.onControlFrame(frame);
    });
    socket.on("data", (chunk: Buffer) => {
      decoder.push(chunk.toString("utf8"));
    });
    socket.on("error", (error: Error) => {
      this.opts.onLog?.(`[omp-bridge] connection error: ${error.message}`);
    });
  }

  private flushPending(): void {
    while (this.pending.length > 0) {
      const payload = this.pending.shift();
      if (payload === undefined) break;
      this.writeToBridge(payload);
    }
  }
}

/** The handshake frame a control client sends before its first command. */
export function controlHandshakeFrame(): Record<string, unknown> {
  return { role: "control", protocolVersion: OMP_BRIDGE_PROTOCOL_VERSION };
}
