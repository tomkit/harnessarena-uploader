import { registerMcpTool } from "./helpers.js";
import { createSubagentMeta, type SubagentMeta } from "./models.js";

// --- TimeSpanTracker ---

export interface TimeSpan {
  type: string;
  start: string;
  end: string;
  seconds: number;
  tool_spans?: ToolSpan[];
  input_tokens?: number;
  output_tokens?: number;
  tokens?: number;
}

export interface ToolSpan {
  name: string;
  category: string;
  start: string;
  end: string;
  seconds: number;
}

interface PendingToolCall {
  name: string;
  category: string;
  startDt: Date;
}

export class TimeSpanTracker {
  private lastUserTs: Date | null = null;
  private lastNonuserTs: Date | null = null;
  private pendingToolCalls = new Map<string, PendingToolCall>();
  private currentTurnToolSpans: ToolSpan[] = [];
  private currentTurnInputTokens = 0;
  private currentTurnOutputTokens = 0;
  private _timeSpans: TimeSpan[] = [];
  private _turnExecTimes: number[] = [];

  onUserTurn(dt: Date): void {
    if (this.lastUserTs && this.lastNonuserTs) {
      const execDur = (this.lastNonuserTs.getTime() - this.lastUserTs.getTime()) / 1000;
      const idleDur = (dt.getTime() - this.lastNonuserTs.getTime()) / 1000;
      if (execDur > 0) {
        const span: TimeSpan = {
          type: "harness_exec",
          start: this.lastUserTs.toISOString(),
          end: this.lastNonuserTs.toISOString(),
          seconds: Math.round(execDur * 10) / 10,
        };
        if (this.currentTurnToolSpans.length > 0) {
          span.tool_spans = [...this.currentTurnToolSpans];
        }
        if (this.currentTurnInputTokens > 0 || this.currentTurnOutputTokens > 0) {
          span.input_tokens = this.currentTurnInputTokens;
          span.output_tokens = this.currentTurnOutputTokens;
          span.tokens = this.currentTurnInputTokens + this.currentTurnOutputTokens;
        }
        this._timeSpans.push(span);
        if (execDur < 1800) {
          this._turnExecTimes.push(execDur);
        }
      }
      if (idleDur > 0) {
        this._timeSpans.push({
          type: "user_idle",
          start: this.lastNonuserTs.toISOString(),
          end: dt.toISOString(),
          seconds: Math.round(idleDur * 10) / 10,
        });
      }
    }
    this.lastUserTs = dt;
    this.lastNonuserTs = null;
    this.currentTurnToolSpans = [];
    this.currentTurnInputTokens = 0;
    this.currentTurnOutputTokens = 0;
    this.pendingToolCalls.clear();
  }

  onNonuserEvent(dt: Date): void {
    this.lastNonuserTs = dt;
  }

  onTokens(inputTokens: number, outputTokens = 0): void {
    this.currentTurnInputTokens += inputTokens;
    this.currentTurnOutputTokens += outputTokens;
  }

  onToolStart(callId: string, name: string, category: string, dt: Date): void {
    this.pendingToolCalls.set(callId, { name, category, startDt: dt });
  }

  onToolEnd(callId: string, dt: Date): ToolSpan | null {
    const pending = this.pendingToolCalls.get(callId);
    if (!pending) return null;
    this.pendingToolCalls.delete(callId);
    const dur = (dt.getTime() - pending.startDt.getTime()) / 1000;
    if (dur >= 0) {
      const toolSpan: ToolSpan = {
        name: pending.name,
        category: pending.category,
        start: pending.startDt.toISOString(),
        end: dt.toISOString(),
        seconds: Math.round(dur * 1000) / 1000,
      };
      this.currentTurnToolSpans.push(toolSpan);
      return toolSpan;
    }
    return null;
  }

  finalize(): { timeSpans: TimeSpan[]; turnExecTimes: number[] } {
    if (this.lastUserTs && this.lastNonuserTs) {
      const execDur = (this.lastNonuserTs.getTime() - this.lastUserTs.getTime()) / 1000;
      if (execDur > 0) {
        const span: TimeSpan = {
          type: "harness_exec",
          start: this.lastUserTs.toISOString(),
          end: this.lastNonuserTs.toISOString(),
          seconds: Math.round(execDur * 10) / 10,
        };
        if (this.currentTurnToolSpans.length > 0) {
          span.tool_spans = [...this.currentTurnToolSpans];
        }
        if (this.currentTurnInputTokens > 0 || this.currentTurnOutputTokens > 0) {
          span.input_tokens = this.currentTurnInputTokens;
          span.output_tokens = this.currentTurnOutputTokens;
          span.tokens = this.currentTurnInputTokens + this.currentTurnOutputTokens;
        }
        this._timeSpans.push(span);
        if (execDur < 1800) {
          this._turnExecTimes.push(execDur);
        }
      }
    }
    return { timeSpans: this._timeSpans, turnExecTimes: this._turnExecTimes };
  }

  // Expose for OpenCode parser direct access
  get lastNonuserTimestamp(): Date | null {
    return this.lastNonuserTs;
  }

  get pendingCalls(): Map<string, PendingToolCall> {
    return this.pendingToolCalls;
  }
}

// --- PlanModeTracker ---

export class PlanModeTracker {
  private _entries = 0;
  private _exits = 0;
  private _start: Date | null = null;
  private _toolSpans: ToolSpan[] = [];
  private _spans: TimeSpan[] = [];

  onEnter(dt: Date): void {
    this._entries++;
    this._start = dt;
    this._toolSpans = [];
  }

  onExit(dt: Date): void {
    this._exits++;
    if (this._start) {
      const dur = (dt.getTime() - this._start.getTime()) / 1000;
      if (dur > 0) {
        const ps: TimeSpan = {
          type: "plan_mode",
          start: this._start.toISOString(),
          end: dt.toISOString(),
          seconds: Math.round(dur * 10) / 10,
        };
        if (this._toolSpans.length > 0) {
          ps.tool_spans = [...this._toolSpans];
        }
        this._spans.push(ps);
      }
      this._start = null;
      this._toolSpans = [];
    }
  }

  onToolSpan(span: ToolSpan): void {
    if (this._start !== null) {
      this._toolSpans.push(span);
    }
  }

  replaceSessionLevel(timeSpans: TimeSpan[], planEntries: number): void {
    const isPlan = this._entries > 0 || planEntries > 0;
    if (!isPlan || timeSpans.length === 0) return;
    if (timeSpans.some((s) => s.type === "plan_mode")) return;

    const allStarts = timeSpans.filter((s) => s.type === "harness_exec").map((s) => s.start);
    const allEnds = timeSpans.filter((s) => s.type === "harness_exec").map((s) => s.end);
    if (allStarts.length === 0 || allEnds.length === 0) return;

    const psStart = allStarts.sort()[0];
    const psEnd = allEnds.sort().at(-1)!;
    const totalExec = timeSpans
      .filter((s) => s.type === "harness_exec")
      .reduce((sum, s) => sum + s.seconds, 0);
    const planToolSpans: ToolSpan[] = [];
    for (const s of timeSpans) {
      if (s.type === "harness_exec" && s.tool_spans) {
        planToolSpans.push(...s.tool_spans);
      }
    }

    // Remove harness_exec spans in-place
    const nonExec = timeSpans.filter((s) => s.type !== "harness_exec");
    timeSpans.length = 0;
    timeSpans.push(...nonExec);

    const planSpanEntry: TimeSpan = {
      type: "plan_mode",
      start: psStart,
      end: psEnd,
      seconds: Math.round(totalExec * 10) / 10,
    };
    if (planToolSpans.length > 0) {
      planSpanEntry.tool_spans = planToolSpans;
    }
    timeSpans.push(planSpanEntry);
  }

  get entries(): number { return this._entries; }
  set entries(v: number) { this._entries = v; }
  get exits(): number { return this._exits; }
  set exits(v: number) { this._exits = v; }
  get spans(): TimeSpan[] { return this._spans; }
  get isActive(): boolean { return this._start !== null; }
}

// --- DailyTracker ---

export interface DailyEntry {
  date: string;
  tokens_in: number;
  tokens_out: number;
  tokens_total: number;
  prompts: number;
  sessions: number;
  subagent_calls: number;
  background_agents: number;
  tool_calls: number;
  mcp_calls: number;
}

export class DailyTracker {
  private data = new Map<string, DailyEntry>();

  add(dateStr: string, updates: Partial<Omit<DailyEntry, "date">>): void {
    if (!this.data.has(dateStr)) {
      this.data.set(dateStr, {
        date: dateStr,
        tokens_in: 0, tokens_out: 0, tokens_total: 0,
        prompts: 0, sessions: 0, subagent_calls: 0,
        background_agents: 0, tool_calls: 0, mcp_calls: 0,
      });
    }
    const entry = this.data.get(dateStr)!;
    for (const [k, v] of Object.entries(updates)) {
      if (k !== "date" && typeof v === "number") {
        (entry as unknown as Record<string, unknown>)[k] =
          ((entry as unknown as Record<string, unknown>)[k] as number ?? 0) + v;
      }
    }
  }

  markSessionStart(dateStr: string): void {
    const entry = this.data.get(dateStr);
    if (entry) entry.sessions = 1;
  }

  finalize(): DailyEntry[] {
    return [...this.data.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
}

// --- ToolClassifier ---

export interface ToolClassification {
  is_subagent: boolean;
  is_background_agent: boolean;
  is_mcp: boolean;
  skill_name: string | null;
  is_plan_enter: boolean;
  is_plan_exit: boolean;
}

export interface ClassifyToolCallFn {
  classifyToolCall(toolName: string, toolInput: Record<string, unknown>): ToolClassification;
}

export class ToolClassifier {
  private _subagentCalls = 0;
  private _backgroundAgents = 0;
  private _mcpCalls = 0;
  readonly toolNames = new Map<string, number>();
  readonly toolCategories = new Map<string, string>();
  readonly skillInvocations = new Map<string, number>();
  readonly mcpServers: Record<string, Record<string, unknown>> = {};

  record(
    toolName: string,
    toolInput: Record<string, unknown>,
    parser: ClassifyToolCallFn | null,
    opts?: {
      timestampDt?: Date;
      planTracker?: PlanModeTracker;
      timeTracker?: TimeSpanTracker;
      subagentCollector?: SubagentCollector;
      dailyTracker?: DailyTracker;
      date?: string;
    },
  ): string {
    this.toolNames.set(toolName, (this.toolNames.get(toolName) ?? 0) + 1);
    let category = "tool";

    if (!parser) {
      // Fallback inline detection
      if (toolName === "Agent") {
        category = "subagent";
        this._subagentCalls++;
        if (opts?.dailyTracker && opts.date) {
          opts.dailyTracker.add(opts.date, { subagent_calls: 1 });
        }
        if (toolInput.run_in_background) {
          this._backgroundAgents++;
          if (opts?.dailyTracker && opts.date) {
            opts.dailyTracker.add(opts.date, { background_agents: 1 });
          }
        }
      } else if (toolName === "Skill") {
        category = "skill";
        const skill = (typeof toolInput === "object" ? (toolInput.skill as string) : null) ?? "unknown";
        this.skillInvocations.set(skill, (this.skillInvocations.get(skill) ?? 0) + 1);
      } else if (toolName.startsWith("mcp__")) {
        category = "mcp";
        this._mcpCalls++;
        if (opts?.dailyTracker && opts.date) {
          opts.dailyTracker.add(opts.date, { mcp_calls: 1 });
        }
      }
      return category;
    }

    const c = parser.classifyToolCall(toolName, toolInput);

    if (c.is_subagent) {
      category = "subagent";
      this._subagentCalls++;
      if (opts?.dailyTracker && opts.date) {
        opts.dailyTracker.add(opts.date, { subagent_calls: 1 });
      }
      if (c.is_background_agent) {
        this._backgroundAgents++;
        if (opts?.dailyTracker && opts.date) {
          opts.dailyTracker.add(opts.date, { background_agents: 1 });
        }
      }
      if (opts?.subagentCollector) {
        opts.subagentCollector.recordSpawn(
          c.is_background_agent ? "background" : "foreground",
          (typeof toolInput === "object" ? (toolInput.subagent_type as string) : "") ?? "",
          (typeof toolInput === "object" ? (toolInput.description as string) : "") ?? "",
        );
      }
    }

    if (c.skill_name) {
      category = "skill";
      this.skillInvocations.set(c.skill_name, (this.skillInvocations.get(c.skill_name) ?? 0) + 1);
    }

    if (c.is_mcp) {
      category = "mcp";
      this._mcpCalls++;
      registerMcpTool(this.mcpServers, toolName);
      if (opts?.dailyTracker && opts.date) {
        opts.dailyTracker.add(opts.date, { mcp_calls: 1 });
      }
    }

    if (c.is_plan_enter && opts?.planTracker) {
      if (opts.timestampDt) {
        opts.planTracker.onEnter(opts.timestampDt);
      } else {
        opts.planTracker.entries++;
      }
    }

    if (c.is_plan_exit && opts?.planTracker) {
      if (opts.timestampDt) {
        opts.planTracker.onExit(opts.timestampDt);
      } else {
        opts.planTracker.exits++;
      }
    }

    this.toolCategories.set(toolName, category);
    return category;
  }

  get subagentCalls(): number { return this._subagentCalls; }
  set subagentCalls(v: number) { this._subagentCalls = v; }
  get backgroundAgents(): number { return this._backgroundAgents; }
  get mcpCalls(): number { return this._mcpCalls; }
  set mcpCalls(v: number) { this._mcpCalls = v; }
}

// --- SubagentCollector ---

export class SubagentCollector {
  private _metas: Partial<SubagentMeta>[] = [];

  recordSpawn(mode = "foreground", subagentType = "", description = ""): void {
    this._metas.push({
      ordinal: this._metas.length,
      mode,
      subagent_type: subagentType,
      description,
    });
  }

  enrich(idx: number, totalTokens = 0, totalToolCalls = 0): void {
    if (idx < this._metas.length) {
      this._metas[idx].total_tokens = totalTokens;
      this._metas[idx].total_tool_calls = totalToolCalls;
    }
  }

  ensureCount(minCount: number): void {
    while (this._metas.length < minCount) {
      this._metas.push({
        ordinal: this._metas.length,
        mode: "foreground",
        subagent_type: "",
        description: "",
      });
    }
  }

  finalize(): SubagentMeta[] {
    return this._metas.map((m) => createSubagentMeta(m));
  }

  get rawMetas(): Partial<SubagentMeta>[] { return this._metas; }
  get length(): number { return this._metas.length; }
}
