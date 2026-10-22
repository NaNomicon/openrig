// OMP-side bridge extension for OpenRig's native-TUI seat shape.
//
// OpenRig launches OMP's OWN interactive TUI inside the seat's tmux pane
// (interactive OMP under a pty). The TUI owns the pane, so the pane cannot be
// scraped for events and cannot be typed into. This extension is the other half
// of that contract: it runs INSIDE the OMP process, reports OMP's session
// events to the OpenRig runner over a Unix socket, and applies the commands the
// runner relays (a Rig message, a steer, an abort, a state read).
//
// It is loaded by OMP through `--trusted-extension <abs path>` and stays
// dependency-free: no OMP imports, no daemon imports beyond the wire contract
// next to this file, no UI access. The TUI stays the only renderer and the only
// approval authority; this extension only reports and applies.

import net from "node:net";
import {
  OMP_BRIDGE_PROTOCOL_VERSION,
  bridgeCommandDeliversAs,
  bridgeEventDedupeKey,
  createBridgeFrameDecoder,
  encodeBridgeFrame,
  parseBridgeCommand,
} from "./omp-bridge-protocol.js";

/** OMP session events the runner projects onto the seat's activity feed. */
const FORWARDED_EVENTS = [
  "session_start",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "auto_compaction_start",
  "auto_compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "goal_updated",
  "tool_approval_requested",
  "tool_approval_resolved",
] as const;

/** The slice of OMP's session manager this extension reads. */
export interface BridgeSessionManager {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getEntries?(): unknown[];
}

/** The slice of OMP's extension context this extension uses. */
export interface BridgeContext {
  sessionManager?: BridgeSessionManager;
  abort?(): void;
}

/** The slice of OMP's extension API this extension uses. */
export interface BridgeApi {
  on(event: string, handler: (event: Record<string, unknown>, ctx: BridgeContext) => void): void;
  sendUserMessage(
    content: string,
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn" | "aside" },
  ): void | Promise<void>;
  getSessionName?(): string | undefined;
}

/** Where the runner's control socket lives (set by the runner's child env). */
export function bridgeSocketPath(): string | null {
  const value = process.env.OPENRIG_OMP_BRIDGE_SOCKET;
  return value && value.trim() ? value.trim() : null;
}

/** Extract a session-entry id from a session manager entry. */
function entryId(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const id = (entry as Record<string, unknown>).id;
  return typeof id === "string" && id ? id : null;
}

/**
 * The bridge's whole job: connect to the runner, report events, apply
 * commands. Exported so the runner-side tests can drive it with a fake socket
 * and a fake OMP API.
 */
export class OmpTuiBridge {
  private socket: net.Socket | null = null;
  private connected = false;
  private readonly seenEvents = new Set<string>();
  private ctx: BridgeContext | null = null;
  private sessionId: string | undefined;
  private sessionFile: string | undefined;

  constructor(
    private readonly api: BridgeApi,
    private readonly socketPath: string,
  ) {}

  /** Connect, handshake, and start reporting. Resolves once connected. */
  async start(): Promise<void> {
    await this.connect();
    this.registerEventHandlers();
    const decoder = createBridgeFrameDecoder((frame) => {
      void this.applyCommand(frame);
    }, () => this.socket?.destroy());
    this.socket?.on("data", (chunk: Buffer) => {
      decoder.push(chunk.toString("utf8"));
    });
  }

  /** Whether the runner connection is up. */
  get isConnected(): boolean {
    return this.connected;
  }

  /** The OMP session id reported to the runner (once known). */
  get reportedSessionId(): string | undefined {
    return this.sessionId;
  }

  /** The OMP session file reported to the runner (once known). */
  get reportedSessionFile(): string | undefined {
    return this.sessionFile;
  }

  /** Close the runner connection. */
  close(): void {
    this.connected = false;
    this.socket?.end();
    this.socket = null;
  }

  private async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect({ path: this.socketPath });
      const onError = (error: Error): void => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        this.socket = socket;
        this.connected = true;
        socket.on("error", () => {
          this.connected = false;
        });
        socket.on("close", () => {
          this.connected = false;
        });
        resolve();
      });
    });
    this.captureSessionIdentity();
    this.write({
      role: "bridge",
      protocolVersion: OMP_BRIDGE_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
    });
  }

  private captureSessionIdentity(): void {
    const manager = this.ctx?.sessionManager;
    if (!manager) return;
    const sessionId = manager.getSessionId();
    const sessionFile = manager.getSessionFile();
    const changed = (sessionId !== undefined && sessionId !== this.sessionId)
      || (sessionFile !== undefined && sessionFile !== this.sessionFile);
    this.sessionId = sessionId ?? this.sessionId;
    this.sessionFile = sessionFile ?? this.sessionFile;
    if (changed) {
      // The runner builds its readiness sidecar and resume token from this.
      this.write({ type: "session_identity", sessionId: this.sessionId, sessionFile: this.sessionFile });
    }
  }

  private registerEventHandlers(): void {
    for (const eventName of FORWARDED_EVENTS) {
      this.api.on(eventName, (event, ctx) => {
        this.ctx = ctx;
        this.captureSessionIdentity();
        this.reportEvent(eventName, event);
      });
    }
  }

  /** Report one OMP event to the runner, dropping a duplicate of the same event. */
  reportEvent(eventName: string, event: Record<string, unknown>): void {
    const key = bridgeEventDedupeKey({ type: eventName, ...event });
    if (key) {
      if (this.seenEvents.has(key)) return;
      this.seenEvents.add(key);
    }
    const payload: Record<string, unknown> = { type: eventName };
    for (const [field, value] of Object.entries(event)) {
      if (field === "type") continue;
      payload[field] = value;
    }
    this.write(payload);
  }

  private reply(id: string | undefined, data: Record<string, unknown>): void {
    this.write({ type: "response", id: id ?? "", success: true, data });
  }

  private acknowledge(id: string | undefined, success: boolean, error?: string): void {
    if (!id) return;
    this.write({ type: "command_ack", id, success, ...(error ? { error } : {}) });
  }

  /** Apply one command frame from the runner, then acknowledge its outcome. */
  async applyCommand(frame: Record<string, unknown>): Promise<void> {
    const command = parseBridgeCommand(frame);
    if (!command) return;
    try {
      switch (command.type) {
        case "abort":
          if (!this.ctx?.abort) throw new Error("OMP abort is unavailable");
          this.ctx.abort();
          break;
        case "get_state":
          this.reply(command.id, { sessionId: this.sessionId, sessionFile: this.sessionFile });
          break;
        case "get_entries":
          this.reply(command.id, { entries: this.entries() });
          break;
        case "prompt":
        case "steer":
        case "follow_up": {
          const message = command.message ?? "";
          if (!message) throw new Error("command message is empty");
          const deliverAs = bridgeCommandDeliversAs(command.type);
          await this.api.sendUserMessage(message, deliverAs ? { deliverAs } : undefined);
          break;
        }
      }
      this.acknowledge(command.id, true);
    } catch (error) {
      this.acknowledge(command.id, false, error instanceof Error ? error.message : String(error));
    }
  }

  /** The session entries the runner can advance its catch-up cursor over. */
  private entries(): Array<{ id: string }> {
    const manager = this.ctx?.sessionManager;
    if (!manager || typeof manager.getEntries !== "function") return [];
    const entries = manager.getEntries();
    if (!Array.isArray(entries)) return [];
    const out: Array<{ id: string }> = [];
    for (const entry of entries) {
      const id = entryId(entry);
      if (id) out.push({ id });
    }
    return out;
  }


  /** Write one frame to the runner. */
  write(frame: Record<string, unknown>): void {
    if (!this.socket || !this.connected) return;
    try {
      this.socket.write(encodeBridgeFrame(frame));
    } catch {
      this.connected = false;
    }
  }
}

/**
 * Extension entry point. OMP calls this with its extension API; the bridge
 * connects to the runner's socket and stays connected for the session. A
 * failure to connect must never break OMP's startup: the TUI is still the
 * seat's UI, it simply has no OpenRig channel.
 */
export default async function activate(pi: BridgeApi): Promise<void> {
  const path = bridgeSocketPath();
  if (!path) return;
  try {
    const bridge = new OmpTuiBridge(pi, path);
    await bridge.start();
    process.on("exit", () => {
      bridge.close();
    });
  } catch {
    // No runner channel: the seat still runs, it just reports nothing.
  }
}
