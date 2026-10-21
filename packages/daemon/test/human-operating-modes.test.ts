// Operating modes for a person: save a mode, apply it, end it. Through the real gateway routes with a temp home (the
// human registry's fragments), a real SQLite schema and an injected clock; the service directly where a writer has to
// fail. Ending a mode undoes only what is still its own: a later choice of the person's stays.
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { gatewayRoutes } from "../src/routes/gateway.js";
import { addHumanFragment, readHumanAvailability, setHumanField } from "../src/domain/gateway/human-registry.js";
import { HumanModeService, registryAvailability, type AvailabilityAccess } from "../src/domain/gateway/human-operating-modes.js";
import { HumanQuietStore } from "../src/domain/gateway/human-quiet-windows.js";
import { RigModeStore } from "../src/domain/rig-mode/rig-mode-store.js";
import type { OperatorContextModeRecord } from "../src/domain/rig-mode/rig-mode-types.js";

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

const person = (entityId: string, prefs: Record<string, unknown> = { deliveryClass: "B" }) => ({
  entityId, class: "human", displayName: entityId, address: `${entityId}@external`, prefs,
  connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "vault://fixture", role: "primary", handle: `U-${entityId.toUpperCase()}` }],
});

function fixture(startIso = "2026-10-20T21:00:00Z", db: Database.Database = createFullTestDb(), home?: string) {
  if (!home) {
    home = mkdtempSync(join(tmpdir(), "modes-route-")); homes.push(home);
    expect(addHumanFragment(person("alex", { deliveryClass: "B", availability: "available" }), home).ok).toBe(true);
    expect(addHumanFragment(person("sam"), home).ok).toBe(true);
  }
  const clock = { now: new Date(startIso) };
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("db" as never, db as never); await next(); });
  app.route("/api/gateway", gatewayRoutes({ home, now: () => clock.now }));
  const call = async (method: string, path: string, body?: unknown, session = "operator@kernel") => {
    const res = await app.request(`/api/gateway/human/${path}`, { method,
      headers: { "Content-Type": "application/json", ...(session ? { "X-OpenRig-Session": session } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const availability = (entityId = "alex") => { const r = readHumanAvailability(entityId, home); return r.ok ? r.availability : `unreadable: ${r.error}`; };
  const quiet = new HumanQuietStore(db);
  return { db, home, clock, call, availability, quiet };
}

const asleep = { availability: "away", expectedBack: "07:00", decisionRoom: "decide my usual asks", exclusions: ["publishing", "spending", "accounts"],
  quiet: "until-end", timezone: "UTC", account: "slack" };
const stateOf = (application: Record<string, any>, consumer: string) =>
  (application.effects as Array<Record<string, any>>).find((e) => e.consumer === consumer)?.state;

describe("saved modes", () => {
  it("a saved mode reads back as agreed, and saving one person's mode leaves another's settings alone", async () => {
    const f = fixture();
    await f.call("PUT", "sam/modes/asleep", { availability: "off", timezone: "UTC" });
    const saved = await f.call("PUT", "alex/modes/Asleep", asleep);
    expect(saved).toMatchObject({ status: 200, body: { mode: { entityId: "alex", name: "asleep",
      availability: { value: "away", expectedBack: "07:00" },
      decisionRoom: { words: "decide my usual asks", exclusions: ["publishing", "spending", "accounts"] },
      delivery: { quiet: { kind: "until-end", timezone: "UTC" }, account: "slack" }, setBy: "operator@kernel" } } });
    expect((await f.call("GET", "alex/modes/asleep")).body.mode).toEqual(saved.body.mode);
    expect((await f.call("GET", "sam/modes/asleep")).body.mode).toMatchObject({ availability: { value: "off" }, decisionRoom: null });
    expect(f.availability("sam")).toBeUndefined(); // saving touches nothing outside the saved row
  });

  it("no decision room is inferred: a mode named asleep with none stated has none, and applying it adds no room", async () => {
    const f = fixture();
    const saved = await f.call("PUT", "alex/modes/asleep", { availability: "away", timezone: "UTC" });
    expect(saved.body.mode.decisionRoom).toBeNull();
    const applied = await f.call("POST", "alex/modes/asleep/apply", {});
    expect(applied.body.application.settings.decisionRoom).toBeNull();
    expect(stateOf(applied.body.application, "decision-room")).toBeUndefined();
  });
});

describe("applying and ending a mode", () => {
  it("applying shows each effect active; a normal end ends each one and restores what was there before", async () => {
    const f = fixture();
    f.quiet.setDaily("alex", { start: "23:00", end: "06:00", timezone: "UTC", setBy: "alex", now: f.clock.now });
    await f.call("PUT", "alex/modes/asleep", asleep);
    const applied = await f.call("POST", "alex/modes/asleep/apply", { until: "07:00", timezone: "UTC" });
    expect(applied.status).toBe(200);
    const app = applied.body.application;
    expect(app).toMatchObject({ modeName: "asleep", scheduledEnd: "2026-10-21T07:00:00.000Z", endedAt: null });
    expect(app.effects.map((e: Record<string, any>) => [e.consumer, e.state])).toEqual([["availability", "active"], ["decision-room", "active"], ["quiet", "active"]]);
    expect(f.availability()).toBe("away");
    expect(f.quiet.show("alex")).toMatchObject({ kind: "until", until: "2026-10-21T07:00:00.000Z", source: `mode-application:${app.applicationId}` });
    expect((await f.call("GET", "alex/mode")).body).toMatchObject({ atDesk: false, current: { applicationId: app.applicationId } });

    f.clock.now = new Date("2026-10-21T05:30:00Z");
    const ended = await f.call("POST", "alex/mode/end", {});
    expect(ended.body).toMatchObject({ atDesk: true, ended: { endReason: "back", endedBy: "operator@kernel" } });
    expect(ended.body.ended.effects.map((e: Record<string, any>) => [e.consumer, e.state])).toEqual([["availability", "ended"], ["decision-room", "ended"], ["quiet", "ended"]]);
    expect(f.availability()).toBe("available");
    expect(f.quiet.show("alex")).toMatchObject({ kind: "daily", start: "23:00", end: "06:00", source: "manual", setBy: "operator@kernel" });
    expect((await f.call("GET", "alex/mode")).body).toMatchObject({ atDesk: true, current: null });
  });

  it("the manual-choice case: quiet extended by hand stays; availability is restored; the decision room ends", async () => {
    const f = fixture();
    await f.call("PUT", "alex/modes/asleep", asleep);
    const app = (await f.call("POST", "alex/modes/asleep/apply", { until: "07:00", timezone: "UTC" })).body.application;
    expect((await f.call("PUT", "alex/quiet", { until: "2026-10-21T09:00:00Z", timezone: "UTC" }, "alex")).status).toBe(200); // by hand
    const ended = (await f.call("POST", "alex/mode/end", {})).body.ended;
    expect(stateOf(ended, "quiet")).toBe("kept");
    expect(stateOf(ended, "availability")).toBe("ended");
    expect(stateOf(ended, "decision-room")).toBe("ended");
    expect(f.quiet.show("alex")).toMatchObject({ until: "2026-10-21T09:00:00.000Z", source: "manual", setBy: "alex" }); // still extended
    expect(f.availability()).toBe("available");
    expect(app.applicationId).toBe(ended.applicationId);
  });

  it("availability changed by hand since the mode started is kept", async () => {
    const f = fixture();
    await f.call("PUT", "alex/modes/asleep", asleep);
    await f.call("POST", "alex/modes/asleep/apply", { until: "07:00", timezone: "UTC" });
    expect(setHumanField("alex", "availability", "focus", f.home).ok).toBe(true);
    const ended = (await f.call("POST", "alex/mode/end", {})).body.ended;
    expect(stateOf(ended, "availability")).toBe("kept");
    expect(stateOf(ended, "quiet")).toBe("ended");
    expect(f.availability()).toBe("focus");
  });

  it("an availability that wasn't authored before the mode is unauthored again after it", async () => {
    const f = fixture();
    await f.call("PUT", "sam/modes/away-from-desk", { availability: "away", timezone: "UTC" });
    await f.call("POST", "sam/modes/away-from-desk/apply", {});
    expect(f.availability("sam")).toBe("away");
    await f.call("POST", "sam/mode/end", {});
    expect(f.availability("sam")).toBeUndefined();
    expect(readFileSync(join(f.home, "gateway", "humans", "sam.yaml"), "utf8")).not.toMatch(/availability/);
  });

  it("switching mode ends the first with reason switched; at desk ends the current one and applies nothing", async () => {
    const f = fixture();
    await f.call("PUT", "alex/modes/away-from-desk", { availability: "away", timezone: "UTC" });
    await f.call("PUT", "alex/modes/out-of-office", { availability: "off", expectedBack: "Monday", timezone: "UTC" });
    const first = (await f.call("POST", "alex/modes/away-from-desk/apply", {})).body.application;
    const second = await f.call("POST", "alex/modes/out-of-office/apply", {});
    expect(second.body.ended).toMatchObject({ applicationId: first.applicationId, endReason: "switched" });
    expect(f.availability()).toBe("off");
    const desk = await f.call("POST", "alex/modes/at desk/apply", {});
    expect(desk.body).toMatchObject({ atDesk: true, application: null, ended: { modeName: "out-of-office", endReason: "back" } });
    expect(f.availability()).toBe("available");
    expect((await f.call("POST", "alex/modes/at-desk/apply", {})).body).toMatchObject({ atDesk: true, application: null, ended: null });
    expect((await f.call("PUT", "alex/modes/at-desk", { availability: "available", timezone: "UTC" })).status).toBe(400);
  });

  it("a mode whose quiet hours run until it ends needs an end time; without one nothing is applied", async () => {
    const f = fixture();
    await f.call("PUT", "alex/modes/asleep", asleep);
    const refused = await f.call("POST", "alex/modes/asleep/apply", {});
    expect(refused).toMatchObject({ status: 400, body: { error: "end_required" } });
    expect(f.availability()).toBe("available");
    expect(f.quiet.show("alex")).toBeNull();
    expect((await f.call("GET", "alex/mode")).body.current).toBeNull();
  });

  it("a scheduled end is recorded as such", async () => {
    const f = fixture();
    await f.call("PUT", "alex/modes/asleep", asleep);
    await f.call("POST", "alex/modes/asleep/apply", { until: "07:00", timezone: "UTC" });
    expect((await f.call("POST", "alex/mode/end", { reason: "scheduled" })).body.ended).toMatchObject({ endReason: "scheduled" });
  });

  it("the application and its effects survive a restart, and ending after it works", async () => {
    const f = fixture();
    await f.call("PUT", "alex/modes/asleep", asleep);
    const app = (await f.call("POST", "alex/modes/asleep/apply", { until: "07:00", timezone: "UTC" })).body.application;
    const after = fixture("2026-10-21T01:00:00Z", f.db, f.home); // a new route stack over the same database and home
    const current = (await after.call("GET", "alex/mode")).body.current;
    expect(current).toMatchObject({ applicationId: app.applicationId, effects: app.effects });
    const ended = (await after.call("POST", "alex/mode/end", {})).body.ended;
    expect(ended.effects.every((e: Record<string, any>) => e.state === "ended")).toBe(true);
  });
});

describe("effects that fail or can't be checked", () => {
  function service(f: ReturnType<typeof fixture>, availability: AvailabilityAccess) {
    return new HumanModeService({ db: f.db, availability, now: () => f.clock.now });
  }

  it("a writer that fails when the mode starts makes that effect failed, not active; the others still apply", async () => {
    const f = fixture();
    const real = registryAvailability(f.home);
    const modes = service(f, { read: real.read, write: () => ({ ok: false, error: "registry is read-only (test)" }) });
    modes.save("alex", { name: "asleep", availability: { value: "away" }, delivery: { quiet: { kind: "daily", start: "22:00", end: "07:00", timezone: "UTC" }, account: null } }, "op");
    const app = modes.apply("alex", "asleep", {}, "op").application!;
    expect(stateOf(app, "availability")).toBe("failed");
    expect(stateOf(app, "quiet")).toBe("active");
    expect(f.availability()).toBe("available");
    const ended = modes.end("alex", "back", "op")!;
    expect(stateOf(ended, "availability")).toBe("ended"); // it never took effect, so nothing to undo
    expect(stateOf(ended, "quiet")).toBe("ended");
  });

  it("a restore that fails is failed, not ended", async () => {
    const f = fixture();
    const real = registryAvailability(f.home);
    let writes = 0;
    const modes = service(f, { read: real.read, write: (id, value) => (++writes === 1 ? real.write(id, value) : { ok: false, error: "disk full (test)" }) });
    modes.save("alex", { name: "away-from-desk", availability: { value: "away" } }, "op");
    modes.apply("alex", "away-from-desk", {}, "op");
    const ended = modes.end("alex", "back", "op")!;
    expect(ended.effects[0]).toMatchObject({ consumer: "availability", state: "failed", detail: expect.stringMatching(/disk full/) });
    expect(f.availability()).toBe("away");
  });

  it("an availability that can't be read at the end is pending, and ending again retries it", async () => {
    const f = fixture();
    const real = registryAvailability(f.home);
    let readable = true;
    const modes = service(f, { read: (id) => (readable ? real.read(id) : { ok: false, error: "registry unreadable (test)" }), write: real.write });
    modes.save("alex", { name: "away-from-desk", availability: { value: "away" } }, "op");
    modes.apply("alex", "away-from-desk", {}, "op");
    readable = false;
    const ended = modes.end("alex", "back", "op")!;
    expect(ended).toMatchObject({ endReason: "back" });
    expect(stateOf(ended, "availability")).toBe("pending");
    expect(modes.current("alex")).toBeNull();
    readable = true;
    expect(stateOf(modes.end("alex", "back", "op")!, "availability")).toBe("ended");
    expect(f.availability()).toBe("available");
  });
});

describe("what a mode never touches", () => {
  const legacy = (scope: string): OperatorContextModeRecord => ({
    autonomy_scope: "bounded_continuation", heartbeat_cadence: "fast", inspection_depth: "forensic", update_detail: "verbose",
    escalation_threshold: "low", concurrency_limit: "serial", permission_prompt_posture: "normal", scope: scope as OperatorContextModeRecord["scope"],
    expiry_or_stale_rule: "re_confirm_on_long_gap", evidence_citation: "seeded legacy binding",
  });
  // Every table except the modes' own and the quiet window they write: seat permissions, posture, lifecycle and the legacy
  // bindings all live outside them.
  const snapshot = (db: Database.Database) => {
    const own = new Set(["human_saved_modes", "human_mode_applications", "human_mode_effects", "human_quiet_windows"]);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
      .map((t) => t.name).filter((t) => !own.has(t));
    return Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).all()]));
  };

  it("applying and ending a mode leaves the legacy bindings, posture and every other table as they were", async () => {
    const f = fixture();
    const store = new RigModeStore(f.db);
    expect(store.setBinding("global_host", null, "sleep", legacy("global_host")).ok).toBe(true); // a legacy saved mode
    expect(store.setBinding("rig", "demo", "focus", legacy("rig")).ok).toBe(true);
    const before = snapshot(f.db);
    expect((before.operator_context_mode_bindings as unknown[]).length).toBeGreaterThan(0);
    const fragmentBefore = readFileSync(join(f.home, "gateway", "humans", "alex.yaml"), "utf8");
    await f.call("PUT", "alex/modes/asleep", asleep);
    await f.call("POST", "alex/modes/asleep/apply", { until: "07:00", timezone: "UTC" });
    await f.call("POST", "alex/modes/out-of-office/apply", {}).catch(() => undefined); // not saved: refused, nothing changes
    await f.call("POST", "alex/modes/at-desk/apply", {});
    expect(snapshot(f.db)).toEqual(before);
    expect(readFileSync(join(f.home, "gateway", "humans", "alex.yaml"), "utf8")).toBe(fragmentBefore); // availability restored as it was
    expect(store.getBinding("global_host", null)).toMatchObject({ mode: "sleep" });
  });
});
