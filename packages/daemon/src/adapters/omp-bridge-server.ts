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

/** Probe an existing Unix socket without letting an unresponsive peer stall startup. */
function isSocketServing(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (serving: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(serving);
    };
    const timer = setTimeout(() => finish(false), 1000);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * The bridge socket server. One instance per seat, owned by the runner.
 */
export class OmpBridgeServer {
  private server: net.Server | null = null;
  private bridgeSocket: net.Socket | null = null;
  private readonly pending: Array<{ payload: string; control?: net.Socket; id?: string }> = [];
  private readonly awaiting = new Map<string, net.Socket>();
  private activeControlSocket: net.Socket | null = null;

  constructor(private readonly opts: OmpBridgeServerOptions) {}

  /** Whether the OMP-side bridge has connected. */
  get bridgeConnected(): boolean {
    return this.bridgeSocket !== null;
  }

  /** Commands waiting for the bridge to connect. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Start serving. A stale socket file left by a previous launch is replaced;
   * a socket that another live runner still serves is refused, not taken over.
   */
  async start(): Promise<void> {
    if (await isSocketServing(this.opts.socketPath)) {
      throw new Error(`Another runner already serves socket ${this.opts.socketPath}`);
    }
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
    this.failAwaiting("bridge server closed");
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
  sendToBridge(frame: Record<string, unknown>, control?: net.Socket): void {
    const payload = encodeBridgeFrame(frame);
    const id = typeof frame.id === "string" ? frame.id : undefined;
    const origin = control ?? this.activeControlSocket ?? undefined;
    if (origin && id) this.awaiting.set(id, origin);
    if (!this.bridgeSocket) {
      if (this.pending.length < MAX_PENDING_COMMANDS) {
        this.pending.push({ payload, control: origin, id });
      } else if (origin && id) {
        this.awaiting.delete(id);
        this.sendAck(origin, id, false, "bridge command queue is full");
      }
      return;
    }
    this.writeToBridge(payload, origin, id);
  }

  private sendAck(socket: net.Socket, id: string, success: boolean, error?: string): void {
    if (!socket.destroyed) socket.write(encodeBridgeFrame({ type: "command_ack", id, success, ...(error ? { error } : {}) }));
  }

  private failAwaiting(reason: string): void {
    for (const [id, socket] of this.awaiting) this.sendAck(socket, id, false, reason);
    this.awaiting.clear();
  }

  private writeToBridge(payload: string, control?: net.Socket, id?: string): void {
    const socket = this.bridgeSocket;
    if (!socket) {
      if (control && id) {
        this.awaiting.delete(id);
        this.sendAck(control, id, false, "bridge disconnected before command delivery");
      }
      return;
    }
    try {
      socket.write(payload, (error) => {
        if (error && control && id) {
          this.awaiting.delete(id);
          this.sendAck(control, id, false, error.message);
        }
      });
    } catch (error) {
      this.opts.onLog?.(`[omp-bridge] write to bridge failed: ${(error as Error).message}`);
      if (control && id) {
        this.awaiting.delete(id);
        this.sendAck(control, id, false, (error as Error).message);
      }
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
            if (this.bridgeSocket === socket) {
              this.bridgeSocket = null;
              this.failAwaiting("bridge disconnected before acknowledgement");
            }
          });
          this.opts.onBridgeReady?.(frame);
          this.flushPending();
        }
        return;
      }
      if (role === "bridge") {
        if (frame.type === "command_ack" && typeof frame.id === "string") {
          const control = this.awaiting.get(frame.id);
          if (control) {
            this.awaiting.delete(frame.id);
            if (!control.destroyed) control.write(encodeBridgeFrame(frame));
            return;
          }
        }
        this.opts.onBridgeFrame(frame);
        return;
      }
      this.activeControlSocket = socket;
      try {
        this.opts.onControlFrame(frame);
      } finally {
        this.activeControlSocket = null;
      }
      return;
    }, (error) => {
      this.opts.onLog?.(`[omp-bridge] rejected connection: ${error.message}`);
      socket.destroy();
    });
    socket.on("close", () => {
      for (const [id, control] of this.awaiting) if (control === socket) this.awaiting.delete(id);
    });
    socket.on("data", (chunk: Buffer) => decoder.push(chunk.toString("utf8")));
    socket.on("error", (error: Error) => {
      this.opts.onLog?.(`[omp-bridge] connection error: ${error.message}`);
    });
  }

  private flushPending(): void {
    while (this.pending.length > 0) {
      const pending = this.pending.shift();
      if (pending) this.writeToBridge(pending.payload, pending.control, pending.id);
    }
  }
}


/** The handshake frame a control client sends before its first command. */
export function controlHandshakeFrame(): Record<string, unknown> {
  return { role: "control", protocolVersion: OMP_BRIDGE_PROTOCOL_VERSION };
}
