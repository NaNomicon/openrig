import { describe, expect, it } from "vitest";
import {
  isBridgeHandshake,
  OMP_BRIDGE_PROTOCOL_VERSION,
} from "../src/adapters/omp-bridge-protocol.js";

describe("OMP bridge handshake protocol version", () => {
  it("accepts the supported version for the bridge role", () => {
    expect(isBridgeHandshake({ role: "bridge", protocolVersion: OMP_BRIDGE_PROTOCOL_VERSION })).toBe(true);
  });

  it("accepts the supported version for the control role", () => {
    expect(isBridgeHandshake({ role: "control", protocolVersion: OMP_BRIDGE_PROTOCOL_VERSION })).toBe(true);
  });

  it("rejects a different numeric protocol version", () => {
    expect(isBridgeHandshake({ role: "bridge", protocolVersion: OMP_BRIDGE_PROTOCOL_VERSION + 1 })).toBe(false);
  });

  it("rejects a non-numeric protocol version", () => {
    expect(isBridgeHandshake({ role: "bridge", protocolVersion: "1" })).toBe(false);
  });

  it("rejects an unknown role", () => {
    expect(isBridgeHandshake({ role: "unknown", protocolVersion: OMP_BRIDGE_PROTOCOL_VERSION })).toBe(false);
  });
});
