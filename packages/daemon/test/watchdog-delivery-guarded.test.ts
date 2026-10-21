// Real scheduler/transport with inert terminal effects: a receipt cannot suppress a current reminder.
import Database from "better-sqlite3";
import stringWidth from "string-width";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import type { ComposerSnapshot } from "../src/domain/composer-prompts.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { makeWatchdogDeliver } from "../src/domain/watchdog-delivery.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { WatchdogScheduler } from "../src/domain/watchdog-scheduler.js";
import { WorkflowInstanceStore } from "../src/domain/workflow-instance-store.js";
import { makeWorkflowKeepalivePolicy } from "../src/domain/policies/workflow-keepalive.js";
import { makeIdleGateQitemPolicy } from "../src/domain/policies/idle-gate-qitem.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function frame(body: string): ComposerSnapshot {
  const rows = body.split("\n");
  return { screen: ["Ready", "────────────────────", `❯ ${rows[0]}`, ...rows.slice(1).map(row => `  ${row}`), "────────────────────", "? for shortcuts", ""].join("\n"),
    cursor: { x: 2 + stringWidth(rows.at(-1)!), y: 1 + rows.length, width: 240, height: 60 }, inMode: false };
}

/** One draft-aware seat on a fake tmux whose only effect is recording what was pasted and submitted. */
function fixture(saved?: Buffer) {
  const db = new Database(saved ?? ":memory:");
  if (!saved) {
    migrate(db, ALL_MIGRATIONS);
    db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
      INSERT INTO nodes(id,rig_id,logical_id,runtime) VALUES ('a','rig','worker','terminal');
      INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('ba','a','worker@test','%1');
      INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running');
      INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh');`);
  }
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  guard.recoverActivation();
  let body: string | null = "";
  let history = "";
  let staged = "";
  const submissions: string[] = [];
  const hooks: { paste?: () => Promise<void> } = {};
  const tmux = new TmuxAdapter(async command => {
    if (command.includes("paste-buffer")) { await hooks.paste?.(); body = staged; }
    if (command.includes("send-keys") && command.includes("Enter")) { submissions.push(body ?? ""); history += `${body}\n`; body = ""; }
    return "";
  }, { writeFile: async (_path, text) => { staged = text; }, unlink: async () => {}, tmpName: () => "/fixture/draft-input", bufferName: () => "draft-input" });
  tmux.deliveryGuard = guard;
  vi.spyOn(tmux, "probeSession").mockResolvedValue({ state: "present" });
  vi.spyOn(tmux, "listPanes").mockImplementation(async name => [{ id: guard.target(name).pane! } as never]);
  vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("node");
  vi.spyOn(tmux, "captureComposerSnapshot").mockImplementation(async () => body == null ? null : frame(body));
  vi.spyOn(tmux, "capturePaneContent").mockImplementation(async () => body == null ? null : history + frame(body).screen);
  const at = Date.now();
  const transport = new SessionTransport({ db, tmuxAdapter: tmux, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db),
    now: () => new Date(at), sleep: async () => {},
    agentActivityStore: { getLatestForNode: () => ({ state: "idle", reason: "fixture idle hook", evidenceSource: "runtime_hook", sampledAt: new Date(at).toISOString(), evidence: null }) } as never });
  transport.guardedDelivery!.recover();
  const outbox = new OutboxHandler(db);
  const deliver = makeWatchdogDeliver({ sessionTransport: transport });
  cleanup.push(async () => { await transport.guardedDelivery!.stop(); db.close(); });
  return { db, outbox, deliver, transport, submissions, hooks, setInput: (text: string) => { body = text; }, enable: () => guard.set("a", { mode: "draft-aware" }, "human@test", "keep draft") };
}

const seat = "worker@test";

/** The queue, watchdog engine and scheduler on a fixture's store, wired as the daemon wires them. `withoutPreview`
 *  leaves out the park-entry lookup, so wakes go with their stored message, as a daemon before the preview sent them. */
function scheduled(f: ReturnType<typeof fixture>, { withoutPreview = false } = {}) {
  const bus = new EventBus(f.db);
  const repo = new QueueRepository(f.db, bus, { transport: f.transport as never, loadHumanRegistry: () => ({ ok: true, entities: [], warnings: [] }) });
  repo.attachOutbox(f.outbox);
  const jobs = new WatchdogJobsRepository(f.db);
  repo.attachWatchdogJobsRepository(jobs);
  const history = new WatchdogHistoryLog(f.db);
  const engine = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: history, eventBus: bus, deliver: f.deliver,
    resolvePreDeliveryTerminalReason: ({ jobId }) => repo.resolveWatchdogPreDeliveryTerminalReason(jobId),
    onWakeAttempt: ({ jobId, deliveryStatus }) => repo.recordWatchdogWakeAttempt(jobId, deliveryStatus),
    ...(withoutPreview ? {} : { resolveDigestEntry: ({ jobId, message }: { jobId: string; message: string }) => repo.parkReminderDigestEntry(jobId, message) }),
  });
  const scheduler = new WatchdogScheduler({ jobsRepo: jobs, policyEngine: engine });
  const park = async (summary: string, transitionNote = "parked") => {
    const row = await repo.create({ sourceSession: "orch@test", destinationSession: seat, body: summary, summary, nudge: false } as never) as unknown as { qitemId: string };
    repo.update({ qitemId: row.qitemId, actorSession: seat, state: "blocked", blockedOn: "external:wait", transitionNote, wakeAfterSeconds: 600 } as never);
    return { qitemId: row.qitemId, jobId: repo.getParkWakeStatus(row.qitemId)!.ref };
  };
  const due = (jobId: string) => {
    const past = new Date(Date.now() - 3_600_000).toISOString();
    f.db.prepare("UPDATE watchdog_jobs SET last_evaluation_at = ?, registered_at = ? WHERE job_id = ?").run(past, past, jobId);
  };
  return { repo, jobs, history, scheduler, park, due };
}
const lone = (jobId: string, occurrenceId: string) => ({ jobId, policy: "periodic-reminder", occurrenceId });
const digest = (...members: Array<[string, string]>) => ({
  jobId: `digest-${members.map(([, o]) => o).join("+")}`, policy: "periodic-reminder", occurrenceId: `digest-${members.map(([, o]) => o).join("+")}`,
  members: members.map(([jobId, occurrenceId]) => ({ jobId, occurrenceId })),
});

describe("watchdog reminders reach the recipient despite earlier delivery records", () => {
  it("retries an unaccounted condition and still delivers a changed condition", async () => {
    const f = fixture();
    await f.enable();
    const s = scheduled(f);
    await s.repo.create({ sourceSession: seat, destinationSession: seat, body: "review", tags: ["gate:review"], nudge: false });
    const policy = (db: Database.Database) => makeIdleGateQitemPolicy({ db, seatActivity: {
      getSeatStateBySession: () => ({ activity: "idle-at-prompt", needsInput: { count: 0 } }),
    } as never });
    const history = new WatchdogHistoryLog(f.db);
    const engine = new WatchdogPolicyEngine({ jobsRepo: s.jobs, historyLog: history, eventBus: new EventBus(f.db),
      deliver: f.deliver, additionalPolicies: [policy(f.db)] });
    const job = s.jobs.register({ policy: "idle-gate-qitem", targetSession: seat, intervalSeconds: 60, registeredBySession: seat,
      specYaml: "message: Gate ready\n" });
    vi.spyOn(s.jobs, "recordConditionReceipt").mockImplementationOnce(() => { throw new Error("receipt interrupted"); });
    await expect(engine.evaluate(job)).rejects.toThrow("receipt interrupted");
    expect(f.submissions).toHaveLength(1);

    const g = fixture(f.db.serialize());
    const jobs = new WatchdogJobsRepository(g.db);
    const reopened = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: new WatchdogHistoryLog(g.db),
      eventBus: new EventBus(g.db), deliver: g.deliver, additionalPolicies: [policy(g.db)] });
    expect((await reopened.evaluate(jobs.getByIdOrThrow(job.jobId))).delivery).toMatchObject({ status: "ok" });
    expect(g.submissions).toHaveLength(1);
    expect(g.submissions[0]).toContain("Gate ready");
    expect(g.submissions[0]).toMatch(/may (?:be repeated|repeat)/i);
    expect((await reopened.evaluate(jobs.getByIdOrThrow(job.jobId))).outcome).toMatchObject({ action: "skip", reason: "gate_condition_unchanged" });
    await scheduled(g).repo.create({ sourceSession: seat, destinationSession: seat, body: "another review", tags: ["gate:review"], nudge: false });
    await reopened.evaluate(jobs.getByIdOrThrow(job.jobId));
    expect(g.submissions).toHaveLength(2);
  });

  it.each(["sending", "indeterminate", "delivered", "failed"] as const)("delivers the current reminder despite an old %s digest record", async (state) => {
    const f = fixture();
    await f.enable();
    const id = "guard-watchdog-occ-a";
    f.outbox.record({ outboxId: id, senderSession: "watchdog@system", destinationSession: seat,
      body: "old body", tags: ["watchdog:digest"] });
    f.db.prepare("UPDATE outbox_entries SET delivery_state = ? WHERE outbox_id = ?").run(state, id);
    const result = await f.deliver({ targetSession: seat, message: "Current A and B" }, digest(["job-a", "occ-a"], ["job-b", "occ-b"]));
    expect(result).toMatchObject({ status: "ok" });
    expect(f.submissions).toHaveLength(1);
    expect(f.submissions[0]).toContain("Current A and B");
    expect(f.submissions[0]).toMatch(/may (?:be repeated|repeat)/i);
    expect(f.submissions[0]).not.toContain("old body");
  });

  it("delivers without requiring the watchdog's outbox bookkeeping", async () => {
    const f = fixture();
    await f.enable();
    vi.spyOn(f.outbox, "record").mockImplementation(() => { throw new Error("watchdog bookkeeping unavailable"); });
    expect(await f.deliver({ targetSession: seat, message: "Both waits are due" }, digest(["a", "a1"], ["b", "b1"]))).toMatchObject({ status: "ok" });
    expect(f.submissions).toHaveLength(1);
    expect(f.submissions[0]).toContain("Both waits are due");
  });

  it.each([false, true])("keeps recurring after accounting interruption: %s", async (interrupted) => {
    const f = fixture();
    await f.enable();
    const instance = new WorkflowInstanceStore(f.db).create({ workflowName: "ongoing", workflowVersion: "1", createdBySession: seat });
    let at = Date.now();
    const jobs = new WatchdogJobsRepository(f.db, () => new Date(at));
    const history = new WatchdogHistoryLog(f.db);
    const engine = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: history, eventBus: new EventBus(f.db),
      deliver: f.deliver, now: () => new Date(at), additionalPolicies: [makeWorkflowKeepalivePolicy({ db: f.db })] });
    const job = jobs.register({ policy: "workflow-keepalive", targetSession: seat, intervalSeconds: 60, registeredBySession: seat,
      specYaml: `message: Continue the current step\ncontext:\n  workflow_instance_id: ${instance.instanceId}\n` });
    if (interrupted) {
      vi.spyOn(history, "record").mockImplementationOnce(() => { throw new Error("accounting interrupted"); });
      await expect(engine.evaluate(jobs.getByIdOrThrow(job.jobId))).rejects.toThrow("accounting interrupted");
    }
    expect((await engine.evaluate(jobs.getByIdOrThrow(job.jobId))).delivery).toMatchObject({ status: "ok" });
    expect(f.submissions).toHaveLength(interrupted ? 2 : 1);
    at += 60_000;
    await engine.evaluate(jobs.getByIdOrThrow(job.jobId));
    expect(f.submissions).toHaveLength(interrupted ? 3 : 2);
    expect(f.submissions.at(-1)).toContain("Continue the current step");
  });

  it("reopens an interrupted wake and submits all current reminders with their continuations", async () => {
    const f = fixture();
    await f.enable();
    const first = scheduled(f, { withoutPreview: true });
    const a = await first.park("A's wait", "continuation: hand the head to the planner");
    first.due(a.jobId);
    let reached!: () => void;
    const pasting = new Promise<void>((done) => { reached = done; });
    let unblock!: () => void;
    f.hooks.paste = () => { reached(); return new Promise((done) => { unblock = done; }); };
    const lost = first.scheduler.runTickNow();
    await pasting;
    const g = fixture(f.db.serialize());
    // Settle the first process before assertions, while retaining its interrupted store as the recovery input.
    unblock();
    await lost;
    const next = scheduled(g);
    const b = await next.park("B's wait");
    next.due(b.jobId);
    await next.scheduler.runTickNow();
    expect(g.submissions).toHaveLength(1);
    expect(g.submissions[0]).toContain(a.qitemId);
    expect(g.submissions[0]).toContain(b.qitemId);
    expect(g.submissions[0]).toContain("hand the head to the planner");
    expect(g.submissions[0]).toMatch(/may (?:be repeated|repeat)/i);
    for (const { jobId } of [a, b]) expect(next.history.listForJob(jobId, 1)[0]).toMatchObject({ deliveryStatus: "ok" });
  });

  it("still protects a person's draft instead of submitting the reminder", async () => {
    const f = fixture();
    await f.enable();
    f.setInput("a person's unfinished message");
    expect(await f.deliver({ targetSession: seat, message: "Reminder" }, lone("a", "a1"))).toMatchObject({ status: "retained" });
    expect(f.submissions).toEqual([]);
  });
});
