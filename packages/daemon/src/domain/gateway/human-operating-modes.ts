// Operating modes for a person: saved modes named after their working life, and the record of applying one.
// A mode bundles three settings: availability (the human registry's `availability`, and when they're expected back),
// decision room (the person's own words plus the exclusions read back; nothing interprets it yet), and delivery (a quiet
// rule in the quiet-hours store's shape, plus where the "back" account goes). "At desk" is no application at all.
//
// Applying a mode records each effect it makes, with the prior value and the identity of the change it wrote. Ending
// it (I'm back, the scheduled end, or a switch) ends an effect only if the latest change is still its own; otherwise
// the effect is `kept`: the person changed it since, and that later choice stands. A restore that fails is `failed`,
// and one that can't be checked yet is `pending`; neither is reported as ended.
//
// This touches only the person's registry `availability`, their quiet window and these tables: never a seat's
// permission selection, native permissions, work posture or lifecycle, and never the legacy operator-context bindings.
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { HumanQuietStore, type QuietWindow } from "./human-quiet-windows.js";
import { readHumanAvailability, setHumanField } from "./human-registry.js";

export type Availability = "available" | "focus" | "away" | "off";
const AVAILABILITY = new Set<string>(["available", "focus", "away", "off"]);

/** A quiet rule in the quiet-hours store's own shapes: a daily local rule, or until the application's end. */
export type QuietRule =
  | { kind: "daily"; start: string; end: string; timezone: string }
  | { kind: "until-end"; timezone: string };

export interface SavedMode {
  entityId: string;
  name: string;
  availability: { value: Availability | null; expectedBack: string | null };
  /** Null: no decision room. Never inferred from the mode's name. */
  decisionRoom: { words: string; exclusions: string[] } | null;
  delivery: { quiet: QuietRule | null; account: string | null };
  setBy: string;
  setAt: string;
}

export type EffectConsumer = "availability" | "quiet" | "decision-room";
/** `handed-off`: a later mode applied while this effect's restore was still owed took over restoring its prior value. */
export type EffectState = "active" | "pending" | "failed" | "ended" | "kept" | "handed-off";

export interface ModeEffect {
  consumer: EffectConsumer;
  prior: unknown;
  changeIdentity: unknown;
  state: EffectState;
  detail: string | null;
  updatedAt: string;
}

export interface ModeApplication {
  applicationId: string;
  entityId: string;
  modeName: string;
  settings: SavedMode;
  startedBy: string;
  startedAt: string;
  scheduledEnd: string | null;
  endedAt: string | null;
  endedBy: string | null;
  endReason: EndReason | null;
  effects: ModeEffect[];
}

export type EndReason = "back" | "scheduled" | "switched";

export class ModeError extends Error {
  constructor(readonly code: "invalid_mode" | "mode_not_found" | "end_required", message: string) {
    super(message);
    this.name = "ModeError";
  }
}

/** The two writers a mode changes outside its own tables; tests inject failing ones. */
export interface AvailabilityAccess {
  /** The authored value, and the id of the latest change recorded through the registry's writers (null: none yet). */
  read(entityId: string): { ok: true; availability: string | undefined; changeId?: string | null } | { ok: false; error: string };
  write(entityId: string, value: Availability | "unset"): { ok: true } | { ok: false; error: string };
}

export function registryAvailability(home: string): AvailabilityAccess {
  return {
    read: (entityId) => readHumanAvailability(entityId, home),
    write: (entityId, value) => {
      const res = setHumanField(entityId, "availability", value, home);
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    },
  };
}

/** Mode names are compared in one spelling: lower case, words joined by hyphens ("Away from desk" is away-from-desk). */
export function modeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
}
export const AT_DESK = "at-desk";

interface SavedRow {
  entity_id: string; name: string; availability: string | null; expected_back: string | null;
  decision_room_words: string | null; decision_room_exclusions: string; quiet_rule: string | null;
  account_destination: string | null; set_by: string; set_at: string;
}
interface ApplicationRow {
  application_id: string; entity_id: string; mode_name: string; settings: string; started_by: string; started_at: string;
  scheduled_end: string | null; ended_at: string | null; ended_by: string | null; end_reason: EndReason | null;
}
interface EffectRow {
  application_id: string; consumer: EffectConsumer; prior: string | null; change_identity: string | null;
  state: EffectState; detail: string | null; updated_at: string;
}

export class HumanModeService {
  private readonly quiet: HumanQuietStore;
  constructor(private readonly deps: { db: Database.Database; availability: AvailabilityAccess; quiet?: HumanQuietStore; now?: () => Date }) {
    this.quiet = deps.quiet ?? new HumanQuietStore(deps.db);
  }

  private now(): Date { return this.deps.now?.() ?? new Date(); }

  save(entityId: string, input: {
    name: string;
    availability?: { value?: string | null; expectedBack?: string | null };
    decisionRoom?: { words?: string | null; exclusions?: string[] } | null;
    delivery?: { quiet?: QuietRule | null; account?: string | null };
  }, actor: string): SavedMode {
    const name = modeName(input.name);
    if (!name) throw new ModeError("invalid_mode", "a mode needs a name");
    if (name === AT_DESK) throw new ModeError("invalid_mode", "at desk is no mode applied, so it isn't saved: apply it to end the current mode");
    const value = input.availability?.value ?? null;
    if (value !== null && !AVAILABILITY.has(value)) throw new ModeError("invalid_mode", `availability must be one of available|focus|away|off (got "${value}")`);
    const words = input.decisionRoom?.words?.trim() || null;
    const exclusions = input.decisionRoom?.exclusions ?? [];
    if (!words && exclusions.length > 0) throw new ModeError("invalid_mode", "exclusions read back from a decision room need the person's words for it");
    const quiet = input.delivery?.quiet ?? null;
    if (quiet) validateQuietRule(quiet);
    const at = this.now().toISOString();
    this.deps.db.prepare(`INSERT INTO human_saved_modes (entity_id, name, availability, expected_back, decision_room_words,
        decision_room_exclusions, quiet_rule, account_destination, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (entity_id, name) DO UPDATE SET availability = excluded.availability, expected_back = excluded.expected_back,
        decision_room_words = excluded.decision_room_words, decision_room_exclusions = excluded.decision_room_exclusions,
        quiet_rule = excluded.quiet_rule, account_destination = excluded.account_destination, set_by = excluded.set_by,
        set_at = excluded.set_at`)
      .run(entityId, name, value, input.availability?.expectedBack ?? null, words, JSON.stringify(words ? exclusions : []),
        quiet ? JSON.stringify(quiet) : null, input.delivery?.account ?? null, actor, at);
    return this.saved(entityId, name)!;
  }

  saved(entityId: string, name: string): SavedMode | null {
    const row = this.deps.db.prepare(`SELECT * FROM human_saved_modes WHERE entity_id = ? AND name = ?`).get(entityId, modeName(name)) as SavedRow | undefined;
    return row ? toSaved(row) : null;
  }

  list(entityId: string): SavedMode[] {
    return (this.deps.db.prepare(`SELECT * FROM human_saved_modes WHERE entity_id = ? ORDER BY name`).all(entityId) as SavedRow[]).map(toSaved);
  }

  /** The person's active application, or null: at desk. */
  current(entityId: string): ModeApplication | null {
    const row = this.deps.db.prepare(`SELECT * FROM human_mode_applications WHERE entity_id = ? AND ended_at IS NULL`).get(entityId) as ApplicationRow | undefined;
    return row ? this.application(row) : null;
  }

  get(applicationId: string): ModeApplication | null {
    const row = this.deps.db.prepare(`SELECT * FROM human_mode_applications WHERE application_id = ?`).get(applicationId) as ApplicationRow | undefined;
    return row ? this.application(row) : null;
  }

  /** Apply a saved mode. At desk ends the current application and applies nothing. Another active mode is ended first
   *  (a switch), so a person has at most one. */
  apply(entityId: string, name: string, input: { scheduledEnd?: Date | null }, actor: string):
    { application: ModeApplication | null; ended: ModeApplication | null } {
    const wanted = modeName(name);
    const at = this.now();
    if (wanted === AT_DESK) return { application: null, ended: this.end(entityId, "back", actor) };
    const mode = this.saved(entityId, wanted);
    if (!mode) throw new ModeError("mode_not_found", `${entityId} has no saved mode "${wanted}": save it first`);
    const scheduledEnd = input.scheduledEnd ?? null;
    if (scheduledEnd && scheduledEnd.getTime() <= at.getTime()) throw new ModeError("end_required", `${scheduledEnd.toISOString()} has already passed`);
    if (mode.delivery.quiet?.kind === "until-end" && !scheduledEnd) {
      throw new ModeError("end_required", `"${wanted}" keeps quiet hours until the mode ends, so applying it needs an end time`);
    }
    const ended = this.end(entityId, "switched", actor);
    const applicationId = randomUUID();
    this.deps.db.prepare(`INSERT INTO human_mode_applications (application_id, entity_id, mode_name, settings, started_by, started_at, scheduled_end)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(applicationId, entityId, wanted, JSON.stringify(mode), actor, at.toISOString(), scheduledEnd?.toISOString() ?? null);

    // Each effect is its own step: one that throws is recorded as that effect's failure and never stops the others, so the
    // record always shows every effect's real state.
    const step = (consumer: EffectConsumer, run: () => void) => {
      try { run(); } catch (error) { this.effect(applicationId, consumer, null, null, "failed", `couldn't apply it: ${(error as Error).message}`); }
    };
    if (mode.availability.value) {
      const value = mode.availability.value;
      step("availability", () => {
        const prior = this.deps.availability.read(entityId);
        if (!prior.ok) { this.effect(applicationId, "availability", null, null, "failed", `couldn't read the current availability: ${prior.error}`); return; }
        // An earlier mode whose restore is still owed, and whose change is still the live one: its prior is the real one.
        const owed = this.owedStillOwn(entityId, "availability", (identity) => {
          const id = identity as { availability: string; changeId?: string | null };
          return prior.availability === id.availability && (id.changeId == null || prior.changeId === id.changeId);
        });
        const wrote = this.deps.availability.write(entityId, value);
        // The change identity is the change record the write left (read back right after it) and the value. A write can
        // also fail after the fragment is saved (re-projecting it fails); the value is then live on the next load, so if
        // it's now the mode's, the change is still recorded as the mode's own and ending puts the prior value back.
        const after = this.deps.availability.read(entityId);
        const landed = after.ok && after.availability === value ? { availability: value, changeId: after.changeId ?? null } : null;
        const priorValue = (owed?.effect.prior as { availability: string | null } | undefined) ?? { availability: prior.availability ?? null };
        if (wrote.ok && landed) this.effect(applicationId, "availability", priorValue, landed, "active", null);
        else this.effect(applicationId, "availability", priorValue, landed, "failed", wrote.ok ? "written, but it didn't read back as written" : wrote.error);
        if (owed && landed) this.handOff(owed, applicationId, mode.name, `availability ${priorValue.availability ?? "not set"}`);
      });
    }
    if (mode.delivery.quiet) {
      const rule = mode.delivery.quiet;
      step("quiet", () => {
        let prior: QuietWindow | null;
        try { prior = this.quiet.show(entityId); }
        catch (error) {
          // Nothing is written when what's there now can't be read: there would be nothing honest to restore.
          this.effect(applicationId, "quiet", null, null, "failed", `couldn't read the current quiet hours: ${(error as Error).message}`);
          return;
        }
        const owed = this.owedStillOwn(entityId, "quiet", (identity) => {
          const id = identity as { revision: number; source: string };
          return !!prior && prior.revision === id.revision && prior.source === id.source;
        });
        if (owed) prior = owed.effect.prior as QuietWindow | null;
        const source = `mode-application:${applicationId}`;
        try {
          const window = rule.kind === "daily"
            ? this.quiet.setDaily(entityId, { start: rule.start, end: rule.end, timezone: rule.timezone, setBy: actor, now: at, source })
            : this.quiet.setUntil(entityId, { until: scheduledEnd!, timezone: rule.timezone, setBy: actor, now: at, source });
          this.effect(applicationId, "quiet", prior, { windowId: window.windowId, revision: window.revision, source }, "active", null);
          if (owed) this.handOff(owed, applicationId, mode.name, describeQuiet(prior));
        } catch (error) {
          this.effect(applicationId, "quiet", prior, null, "failed", (error as Error).message);
        }
      });
    }
    if (mode.decisionRoom) step("decision-room", () => this.effect(applicationId, "decision-room", null, { applicationId }, "active", null));
    return { application: this.get(applicationId), ended };
  }

  /** End the person's active application: each effect ends only if the latest change is still its own. Returns the
   *  ended application, or null when none was active. Every time, restorations still pending or failed from earlier
   *  applications are tried again (see unresolved), so a later mode never hides an older one's. */
  end(entityId: string, reason: EndReason, actor: string): ModeApplication | null {
    const at = this.now();
    const row = this.deps.db.prepare(`SELECT * FROM human_mode_applications WHERE entity_id = ? AND ended_at IS NULL`).get(entityId) as ApplicationRow | undefined;
    if (row) {
      this.deps.db.prepare(`UPDATE human_mode_applications SET ended_at = ?, ended_by = ?, end_reason = ? WHERE application_id = ?`)
        .run(at.toISOString(), actor, reason, row.application_id);
      this.endEffects(entityId, row.application_id, actor, at);
    }
    for (const earlier of this.unresolvedApplicationIds(entityId)) {
      if (earlier !== row?.application_id) this.endEffects(entityId, earlier, actor, at);
    }
    return row ? this.get(row.application_id) : null;
  }

  /** Restorations from ended applications that are still pending or failed: owed in the coming-back report, and tried
   *  again by every end. Oldest application first. */
  unresolved(entityId: string): Array<{ applicationId: string; modeName: string; endedAt: string; effect: ModeEffect }> {
    const out: Array<{ applicationId: string; modeName: string; endedAt: string; effect: ModeEffect }> = [];
    for (const id of this.unresolvedApplicationIds(entityId)) {
      const app = this.get(id)!;
      for (const effect of app.effects) {
        if (effect.state === "pending" || (effect.state === "failed" && effect.changeIdentity !== null)) {
          out.push({ applicationId: id, modeName: app.modeName, endedAt: app.endedAt!, effect });
        }
      }
    }
    return out;
  }

  private unresolvedApplicationIds(entityId: string): string[] {
    return (this.deps.db.prepare(`SELECT DISTINCT a.application_id AS id, a.started_at FROM human_mode_applications a
        JOIN human_mode_effects e ON e.application_id = a.application_id
        WHERE a.entity_id = ? AND a.ended_at IS NOT NULL
          AND (e.state = 'pending' OR (e.state = 'failed' AND e.change_identity IS NOT NULL))
        ORDER BY a.started_at`).all(entityId) as Array<{ id: string }>).map((r) => r.id);
  }

  private endEffects(entityId: string, applicationId: string, actor: string, at: Date): void {
    for (const effect of this.effects(applicationId)) {
      if (effect.state === "ended" || effect.state === "kept" || effect.state === "handed-off") continue;
      if (effect.state === "failed" && effect.changeIdentity === null) {
        this.effect(applicationId, effect.consumer, effect.prior, null, "ended", "it never took effect when the mode started, so there was nothing to undo");
        continue;
      }
      // As when applying: a throw while ending one effect is that effect's failure, never the others'.
      try {
        if (effect.consumer === "decision-room") this.effect(applicationId, "decision-room", null, effect.changeIdentity, "ended", null);
        else if (effect.consumer === "availability") this.endAvailability(entityId, applicationId, effect);
        else this.endQuiet(entityId, applicationId, effect, actor, at);
      } catch (error) {
        this.effect(applicationId, effect.consumer, effect.prior, effect.changeIdentity, "failed", `couldn't end it: ${(error as Error).message}`);
      }
    }
  }

  /** The latest earlier application's still-owed restore of this consumer, if its change is still the live one. */
  private owedStillOwn(entityId: string, consumer: EffectConsumer, stillOwn: (identity: unknown) => boolean) {
    const owed = this.unresolved(entityId).filter((u) => u.effect.consumer === consumer).at(-1);
    return owed && owed.effect.changeIdentity !== null && stillOwn(owed.effect.changeIdentity) ? owed : null;
  }

  /** Close an earlier effect whose restore a later mode took over: not kept (nobody chose otherwise), not ended (nothing
   *  was restored yet), but handed to the mode that now restores its prior value. */
  private handOff(owed: { applicationId: string; effect: ModeEffect }, toApplicationId: string, toMode: string, prior: string): void {
    this.effect(owed.applicationId, owed.effect.consumer, owed.effect.prior, owed.effect.changeIdentity, "handed-off",
      `handed to ${toMode} (${toApplicationId}), which restores ${prior} when it ends`);
  }

  private endAvailability(entityId: string, applicationId: string, effect: ModeEffect): void {
    const identity = effect.changeIdentity as { availability: string; changeId?: string | null };
    const wrote = identity.availability;
    const prior = (effect.prior as { availability: string | null }).availability;
    const now = this.deps.availability.read(entityId);
    if (!now.ok) {
      this.effect(applicationId, "availability", effect.prior, effect.changeIdentity, "pending", `couldn't read the current availability to check it's still this mode's: ${now.error}`);
      return;
    }
    // Still the mode's own only if the latest recorded change is the mode's (so away, then focus, then away by hand is
    // not) and the value is the one it wrote (so a hand edit of the file is not). A record from before change ids
    // existed falls back to the value alone.
    const sameChange = identity.changeId == null || now.changeId === identity.changeId;
    if (now.availability !== wrote || !sameChange) {
      this.effect(applicationId, "availability", effect.prior, effect.changeIdentity, "kept",
        `changed since the mode started (now ${now.availability ?? "not set"}${now.availability === wrote ? ", set again since" : ""}); that choice stands`);
      return;
    }
    const restored = this.deps.availability.write(entityId, (prior ?? "unset") as Availability | "unset");
    if (restored.ok) this.effect(applicationId, "availability", effect.prior, effect.changeIdentity, "ended", `restored to ${prior ?? "not set"}`);
    else this.effect(applicationId, "availability", effect.prior, effect.changeIdentity, "failed", `couldn't restore ${prior ?? "not set"}: ${restored.error}`);
  }

  private endQuiet(entityId: string, applicationId: string, effect: ModeEffect, actor: string, at: Date): void {
    const wrote = effect.changeIdentity as { windowId: string; revision: number; source: string };
    const prior = effect.prior as QuietWindow | null;
    try {
      const now = this.quiet.show(entityId);
      if (!now || now.revision !== wrote.revision || now.source !== wrote.source) {
        this.effect(applicationId, "quiet", effect.prior, effect.changeIdentity, "kept",
          now ? `quiet hours were changed since the mode started (now revision ${now.revision}, set by ${now.setBy}); they stay as set`
            : "quiet hours were cleared since the mode started; they stay cleared");
        return;
      }
      // Still the mode's own rule: put back what was there before it, as it was, in one transaction with any ended mark
      // carried across, so no reader sees quiet restarted in between. The mark is the person's own "I'm back" for
      // tonight during the mode (a manual end changes tonight, not the rule), or the prior window's mark for an
      // occurrence that is still the current one.
      const personEnded = now.ended ?? null;
      let detail = "";
      this.deps.db.transaction(() => {
        if (prior && prior.kind === "daily") {
          const w = this.quiet.setDaily(entityId, { start: prior.start!, end: prior.end!, timezone: prior.timezone, setBy: actor, now: at, source: prior.source });
          detail = `restored the daily quiet hours ${prior.start}-${prior.end} ${prior.timezone} (revision ${w.revision})`;
        } else if (prior && prior.kind === "until" && Date.parse(prior.until!) > at.getTime()) {
          const w = this.quiet.setUntil(entityId, { until: new Date(prior.until!), timezone: prior.timezone, setBy: actor, now: at, source: prior.source });
          detail = `restored quiet hours until ${prior.until} (revision ${w.revision})`;
        } else {
          const c = this.quiet.clear(entityId, { clearedBy: actor, now: at });
          detail = prior ? `the quiet hours before it had already run out, so none were restored (revision ${c.revision})` : `cleared the mode's quiet hours (revision ${c.revision})`;
          return;
        }
        const state = this.quiet.quietStateFor(entityId, at);
        if (!state.active) return;
        // Only tonight's mark carries: one for the current occurrence (an until-window has just the one while it lasts),
        // never one the person left on an earlier night of a daily mode.
        const tonight = <T extends { occurrence: string }>(ended: T | null | undefined): T | null =>
          ended && (ended.occurrence === state.occurrence || ended.occurrence === "until") ? ended : null;
        const mark = tonight(personEnded) ?? (prior?.ended && prior.ended.occurrence === state.occurrence ? prior.ended : null);
        if (!mark) return;
        this.quiet.restoreEnded(entityId, state.revision, { occurrence: state.occurrence, by: mark.by, at: mark.at });
        detail += "; tonight stays off, as you set it";
      })();
      this.effect(applicationId, "quiet", effect.prior, effect.changeIdentity, "ended", detail);
    } catch (error) {
      this.effect(applicationId, "quiet", effect.prior, effect.changeIdentity, "failed", `couldn't restore quiet hours: ${(error as Error).message}`);
    }
  }

  private effect(applicationId: string, consumer: EffectConsumer, prior: unknown, changeIdentity: unknown, state: EffectState, detail: string | null): void {
    this.deps.db.prepare(`INSERT INTO human_mode_effects (application_id, consumer, prior, change_identity, state, detail, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (application_id, consumer) DO UPDATE SET prior = excluded.prior,
        change_identity = excluded.change_identity, state = excluded.state, detail = excluded.detail, updated_at = excluded.updated_at`)
      .run(applicationId, consumer, prior === undefined ? null : JSON.stringify(prior), changeIdentity === null ? null : JSON.stringify(changeIdentity),
        state, detail, this.now().toISOString());
  }

  private effects(applicationId: string): ModeEffect[] {
    return (this.deps.db.prepare(`SELECT * FROM human_mode_effects WHERE application_id = ? ORDER BY consumer`).all(applicationId) as EffectRow[])
      .map((r) => ({ consumer: r.consumer, prior: r.prior === null ? null : JSON.parse(r.prior), changeIdentity: r.change_identity === null ? null : JSON.parse(r.change_identity),
        state: r.state, detail: r.detail, updatedAt: r.updated_at }));
  }

  private application(row: ApplicationRow): ModeApplication {
    return { applicationId: row.application_id, entityId: row.entity_id, modeName: row.mode_name, settings: JSON.parse(row.settings) as SavedMode,
      startedBy: row.started_by, startedAt: row.started_at, scheduledEnd: row.scheduled_end, endedAt: row.ended_at, endedBy: row.ended_by,
      endReason: row.end_reason, effects: this.effects(row.application_id) };
  }
}

function validateQuietRule(rule: QuietRule): void {
  const hhmm = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (rule.kind === "daily") {
    if (!hhmm.test(rule.start) || !hhmm.test(rule.end)) throw new ModeError("invalid_mode", "a daily quiet rule needs start and end as 24-hour HH:MM");
    if (rule.start === rule.end) throw new ModeError("invalid_mode", "a daily quiet rule's start and end are the same time");
  } else if (rule.kind !== "until-end") {
    throw new ModeError("invalid_mode", `a quiet rule is daily or until-end (got "${(rule as { kind: string }).kind}")`);
  }
  if (!rule.timezone) throw new ModeError("invalid_mode", "a quiet rule needs a timezone");
}

function toSaved(row: SavedRow): SavedMode {
  return {
    entityId: row.entity_id, name: row.name,
    availability: { value: row.availability as Availability | null, expectedBack: row.expected_back },
    decisionRoom: row.decision_room_words ? { words: row.decision_room_words, exclusions: JSON.parse(row.decision_room_exclusions) as string[] } : null,
    delivery: { quiet: row.quiet_rule ? JSON.parse(row.quiet_rule) as QuietRule : null, account: row.account_destination },
    setBy: row.set_by, setAt: row.set_at,
  };
}

function describeQuiet(window: QuietWindow | null): string {
  if (!window) return "no quiet hours";
  return window.kind === "daily" ? `the daily quiet hours ${window.start}-${window.end} ${window.timezone}` : `quiet hours until ${window.until}`;
}
