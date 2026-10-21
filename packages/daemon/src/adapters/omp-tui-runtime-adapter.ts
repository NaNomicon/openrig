import net from "node:net";
import nodePath from "node:path";
import { OMP_BRIDGE_PROTOCOL_VERSION, ompBridgeSocketPath } from "./omp-bridge-protocol.js";
import { OmpRuntimeAdapter } from "./omp-runtime-adapter.js";
import type { RunnerUiMode } from "./pi-runner-protocol.js";

/** How long a proxied delivery waits for the runner's bridge socket. */
const BRIDGE_DELIVERY_TIMEOUT_MS = 3_000;

/** How long the writer holds the socket open after its last frame, so the
 *  runner has read both frames before the connection closes. */
const BRIDGE_DELIVERY_LINGER_MS = 150;

/** OMP's native TUI runs in the seat pane; OMP answers approvals in its own
 *  TUI, with no OpenRig auto-cancel. */
export class OmpTuiRuntimeAdapter extends OmpRuntimeAdapter {
  override readonly runtime = "omp-tui" as const;

  protected override get childRuntime(): "omp" { return "omp"; }
  protected override get uiMode(): RunnerUiMode { return "native"; }

  /** Deliver a Rig message into OMP's own conversation over the runner's
   *  bridge socket. The pane is OMP's TUI, so a message must never be typed
   *  into the pane. */
  async deliverMessage(sessionName: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const socketPath = ompBridgeSocketPath(nodePath.join(this.stateRoot, sessionName));
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: "nothing to deliver" };
    // The pane-path convention survives: a "/followup <text>" prefix queues
    // after the running turn instead of steering it.
    const followUp = trimmed.startsWith("/followup ") ? trimmed.slice("/followup ".length).trim() : "";
    const command = followUp
      ? { type: "follow_up", message: followUp }
      : { type: "prompt", message: trimmed };
    return await new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (result: { ok: boolean; error?: string }): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        socket.end();
        resolve(result);
      };
      const socket = net.connect({ path: socketPath });
      timer = setTimeout(
        () => finish({ ok: false, error: `the runner's bridge socket did not answer within ${BRIDGE_DELIVERY_TIMEOUT_MS} ms` }),
        BRIDGE_DELIVERY_TIMEOUT_MS,
      );
      socket.once("connect", () => {
        const write = (frame: Record<string, unknown>): void => {
          socket.write(`${JSON.stringify(frame)}\n`);
        };
        write({ role: "control", protocolVersion: OMP_BRIDGE_PROTOCOL_VERSION });
        write(command);
        setTimeout(() => finish({ ok: true }), BRIDGE_DELIVERY_LINGER_MS);
      });
      socket.once("error", (error: Error) => {
        finish({ ok: false, error: error.message });
      });
    });
  }
}
