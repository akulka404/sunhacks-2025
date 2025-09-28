"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import simConfig from "@/config/simulation.json";
import { buildAssignmentSteps } from "@/lib/simulator";

type Plan = {
  actors?: Array<{
    id: string;
    capabilities?: string[];
    capacity?: number;
    current_load?: number;
    resources?: Record<string, number>;
    agentic_override?: boolean;
    policy_block?: boolean;
  }>;
  tasks?: Array<{
    id: string;
    demand?: number;
    deadline?: number; // epoch seconds or minutes-from-now (normalized server-side when possible)
    actor?: string;
    category?: string;
    flexible?: boolean;
    required_resources?: Record<string, number>;
    policy_block?: boolean;
  }>;
  constraints?: Array<{ type: 'capacity' | string; actor?: string; limit?: number }>;
  objectives?: Record<string, number>;
};

function randomCoord(seed: string) {
  // pseudo-random positions based on id string
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const x = 10 + (h % 80);
  const y = 10 + ((h >>> 7) % 60);
  return { x, y };
}

export default function SimulationPage() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [worldState, setWorldState] = useState<Plan | null>(null); // mutable state used by agentic mode
  const [hover, setHover] = useState<{ x: number; y: number; content: string } | null>(null);
  const [steps, setSteps] = useState<Array<any>>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [hasBootstrapped, setHasBootstrapped] = useState(false);
  const [agenticMode, setAgenticMode] = useState(false);
  const timerRef = useRef<number | null>(null);
  const lastLoggedIndexRef = useRef<number>(-1);
  const [log, setLog] = useState<Array<string>>([]);
  const [speed, setSpeed] = useState<number>(1100); // ms per step
  // Stable base time for relative deadline labels (won't drift during run)
  const baseTimeRef = useRef<number>(Math.floor(Date.now() / 1000));
  const [whyOpen, setWhyOpen] = useState<string | null>(null); // taskId for tooltip
  const [injectNovelTask, setInjectNovelTask] = useState(false);
  // Live settings (session-local overrides)
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rerunLoading, setRerunLoading] = useState(false);
  // Comparison panel state
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [comparisonData, setComparisonData] = useState<{
    deterministicResults?: any;
    agenticResults?: any;
  }>({});
  // Actor load tracking separate from plan to avoid triggering rebuilds
  const [actorLoads, setActorLoads] = useState<Record<string, number>>({});
  const [localConfig, setLocalConfig] = useState<any>(() => {
    try {
      const saved = sessionStorage.getItem('crisisverse.configOverrides');
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  });

  // Helper to read from local override else base config
  const cfg = useMemo(() => {
    return {
      ...simConfig,
      ...(localConfig || {}),
      throttle: { ...(simConfig as any).throttle, ...(localConfig?.throttle || {}) },
      llm: { ...(simConfig as any).llm, ...(localConfig?.llm || {}) },
      topN: { ...(simConfig as any).topN, ...(localConfig?.topN || {}) },
      agentTemplates: { ...(simConfig as any).agentTemplates, ...(localConfig?.agentTemplates || {}) },
      constraints: { ...(simConfig as any).constraints, ...(localConfig?.constraints || {}) },
    } as any;
  }, [localConfig]);

  // persist overrides in session
  useEffect(() => {
    try { sessionStorage.setItem('crisisverse.configOverrides', JSON.stringify(localConfig || {})); } catch {}
  }, [localConfig]);

  useEffect(() => {
    const raw = sessionStorage.getItem("crisisverse.plan");
    if (raw) {
      try {
        const p = JSON.parse(raw);
        setPlan(p);
        setWorldState(JSON.parse(JSON.stringify(p)));
      } catch {}
    }
  }, []);

  // Start handler: ensure fresh plan before starting the timer (first run only)
  const handleStart = async () => {
    if (!hasBootstrapped) {
      try {
        sessionStorage.removeItem('crisisverse.plan');
        const lastPrompt = sessionStorage.getItem('crisisverse.lastPrompt') || '';
        if (lastPrompt) {
          const res = await fetch('/api/simulate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: lastPrompt }),
          });
          const data = await res.json().catch(() => null);
          if (data?.ok && data?.plan) {
            sessionStorage.setItem('crisisverse.plan', JSON.stringify(data.plan));
            setPlan(data.plan);
            setWorldState(JSON.parse(JSON.stringify(data.plan)));
          }
        }
      } catch {}
      setHasBootstrapped(true);
    }
    setRunning(true);
  };

  // Prefer worldState when agentic mode is enabled, else fall back to static plan
  // Board parity: in agentic mode, reflect worldState tasks so injected tasks appear immediately
  const baseActors = (agenticMode && worldState?.actors) ? (worldState?.actors as any[]) : (plan?.actors ?? []);
  const tasks = (agenticMode && worldState?.tasks) ? (worldState?.tasks as any[]) : (plan?.tasks ?? []);
  
  // Combine base actors with real-time load tracking
  const actors = baseActors.map(actor => ({
    ...actor,
    current_load: (actor.current_load || 0) + (actorLoads[actor.id] || 0)
  }));

  const edges = useMemo(() => {
    // connect each actor to the next; also connect task->actor if present
    const e: Array<{ from: string; to: string }> = actors
      .slice(0, -1)
      .map((a, i) => ({ from: a.id, to: actors[i + 1].id }));
    tasks.forEach((t) => {
      if (t.actor) e.push({ from: t.id, to: t.actor });
    });
    return e;
  }, [actors, tasks]);

  // basic layout tweak: stagger actors vertically by index
  const actorIndexMap = new Map(actors.map((a, i) => [a.id, i] as const));
  function positionForId(id: string) {
    const base = randomCoord(id);
    const idx = actorIndexMap.get(id) ?? 0;
    // Distribute x fairly across width for revealed sequence; keep some jitter from base
    const cols = Math.max(3, Math.ceil(Math.sqrt(Math.max(actors.length, 6))));
    const row = Math.floor(idx / cols);
    const col = idx % cols;
    const x = 8 + (col * (84 / (cols - 1))) + ((base.x % 6) - 3); // 8% padding, 84% spread, +/-3% jitter
    const y = 18 + (row * 14) + ((base.y % 6) - 3); // start 18%, step rows, jitter
    return { x: Math.max(6, Math.min(94, x)), y: Math.max(10, Math.min(88, y)) };
  }

  // --- Simple load-balanced simulation engine ---
  function getActorAvail(a: any) {
    const cap = typeof a.capacity === "number" ? a.capacity : 0;
    const load = typeof a.current_load === "number" ? a.current_load : 0;
    return Math.max(0, cap - load);
  }

  function constraintLimitFor(actorId: string): number | null {
    const cs = plan?.constraints ?? [];
    // locate a capacity constraint for actor
    const match = cs.find((c) => c.type === "capacity" && c.actor === actorId && typeof c.limit === "number");
    return match ? (match.limit as number) : null;
  }
  function constraintLimitForWS(ws: Plan, actorId: string): number | null {
    const cs = ws?.constraints ?? [];
    const match = cs.find((c) => c.type === 'capacity' && c.actor === actorId && typeof c.limit === 'number');
    return match ? (match.limit as number) : null;
  }

  // Constraint helpers (config-driven; only enforce when enabled)
  function isTaskAfterDeadline(task: any): boolean {
    const tCfg: any = (cfg as any)?.constraints?.time || {};
    const flexField = tCfg.flexibleField || 'flexible';
    const isFlexible = Boolean((task as any)?.[flexField]);
    if (isFlexible) return false;
    const dl = Number((task as any)?.deadline);
    if (!dl || isNaN(dl)) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    const target = dl > 1e7 ? dl : (baseTimeRef.current + Math.max(0, Math.round(dl)) * 60);
    return nowSec > target;
  }

  function hasResourcesFor(actor: any, task: any): boolean {
    const rCfg: any = (cfg as any)?.constraints?.resource || {};
    const reqField = rCfg.taskRequiredField || 'required_resources';
    const invField = rCfg.actorInventoryField || 'resources';
    const req: Record<string, number> = (task as any)?.[reqField] || {};
    const inv: Record<string, number> = (actor as any)?.[invField] || {};
    for (const k of Object.keys(req)) {
      const need = Math.max(0, Number(req[k] ?? 0));
      const have = Math.max(0, Number(inv[k] ?? 0));
      if (have < need) return false;
    }
    return true;
  }

  function violatesPolicy(actor: any, task: any): boolean {
    const pCfg: any = (cfg as any)?.constraints?.policy || {};
    const aField = pCfg.actorField || 'policy_block';
    const tField = pCfg.taskField || 'policy_block';
    const ab = Boolean((actor as any)?.[aField]);
    const tb = Boolean((task as any)?.[tField]);
    return ab || tb;
  }

  // ---- Types and derived state for board rendering ----
  type TaskState = {
    stage: 'blocked' | 'assess' | 'agent' | 'assign' | 'execute' | 'complete';
    progress?: number;
    message?: string;
    details?: any;
    actors?: string[];
  };

  function deriveTaskStates(allSteps: any[], uptoIndex: number, allTasks: any[]): Map<string, TaskState> {
    const map = new Map<string, TaskState>();
    for (const t of allTasks || []) map.set(t.id, { stage: 'assess' });
    const end = Math.min(allSteps.length - 1, Math.max(0, uptoIndex));
    
    // Track which tasks have simulation steps
    const tasksWithSteps = new Set<string>();
    
    for (let i = 0; i <= end; i++) {
      const st = allSteps[i];
      if (!st) continue;
      const id = st.taskId;
      if (!id) continue;
      
      tasksWithSteps.add(id);
      const cur = map.get(id) || { stage: 'assess' };
      
      if (st.type === 'blocked' || st.type === 'unassigned' || st.type === 'skip') {
        map.set(id, { stage: 'blocked', message: st.message, details: st.details });
      } else if (st.type === 'assign') {
        map.set(id, { stage: 'assign' });
      } else if (st.type === 'execute') {
        map.set(id, { stage: 'execute', progress: st.progress, actors: st.actors });
      } else if (st.type === 'complete') {
        map.set(id, { stage: 'complete' });
      } else if (st.type === 'agent' || st.type === 'agentThink' || st.type === 'agentAction') {
        map.set(id, { stage: 'agent', message: st.message });
      } else if (!map.has(id)) {
        map.set(id, cur);
      }
    }
    
    // Handle novel tasks that don't have simulation steps
    // Check if they have dynamic status from agentic processing
    for (const t of allTasks || []) {
      if (!tasksWithSteps.has(t.id) && agenticMode && worldState) {
        // Check if this task has been processed by agents
        const wsTask = worldState.tasks?.find((wt: any) => wt.id === t.id);
        if (wsTask) {
          const demand = wsTask.demand || 0;
          const originalDemand = t.demand || 0;
          const status = (wsTask as any).status;
          const chosenBy = (wsTask as any)._chosen_by;
          
          if (demand <= 0) {
            // Task completed
            map.set(t.id, { stage: 'complete' });
          } else if (status === 'in_progress' || chosenBy) {
            // Task in progress
            const progress = originalDemand > 0 ? Math.max(0, Math.min(100, ((originalDemand - demand) / originalDemand) * 100)) : 100;
            map.set(t.id, { stage: 'execute', progress, actors: chosenBy ? [chosenBy] : [] });
          } else {
            // Task still awaiting assignment
            map.set(t.id, { stage: 'assess', message: 'Novel task awaiting assignment' });
          }
        }
      }
    }
    
    return map;
  }

  function actorMatchesCategory(actor: any, category?: string): boolean {
    const caps: string[] = ([] as any[])
      .concat(actor?.capabilities || [])
      .concat((actor as any)?.skills || [])
      .map((s: any) => String(s || '').toLowerCase());
    const c = String(category || '').toLowerCase();
    if (!c) return true;
    return caps.includes(c) || caps.includes('generalist');
  }

  function formatDeadlineStable(dl: number): string {
    const nowSec = Math.floor(Date.now() / 1000);
    const target = dl > 1e7 ? dl : (baseTimeRef.current + Math.max(0, Math.round(dl)) * 60);
    const diff = target - nowSec;
    const abs = Math.abs(diff);
    const mins = Math.round(abs / 60);
    if (diff >= 0) {
      if (mins < 60) return `in ${mins} min`;
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return `in ${h}h ${m}m`;
    } else {
      if (mins < 60) return `${mins} min ago`;
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return `${h}h ${m}m ago`;
    }
  }

  // Dynamic Threat Assessment: combines AI-derived baseline with current simulation progress and blockages
  function computeAssessment(p: Plan, states: Map<string, TaskState>) {
    const T = p.tasks || [];
    const catWeight: Record<string, number> = (cfg as any)?.categoryWeights || { hospital: 1.0, power: 0.9, evac_zone: 0.85, shelter: 0.8, comms: 0.7 };
    const now = Date.now() / 1000;

    // Helper: deadline urgency 0.1..1 (so non-deadline tasks still carry weight)
    const urgencyOf = (dl?: number | null) => (dl ? Math.max(0.1, Math.min(1, 1 / Math.max(0.5, (dl - now) / 3600))) : 0.5);

    // AI baseline (static, from plan contents)
    let totalDemand = 0;
    let weightedDemand = 0;
    let totalBaseScore = 0; // demand * w * urgency-weight mix
    const perTaskBase: Record<string, number> = {};

    for (const t of T) {
      const demand = Math.max(0, t.demand ?? 0);
      const w = catWeight[(t.category || '').toLowerCase()] ?? 0.6;
      const urg = urgencyOf(t.deadline ?? null);
      const baseScore = demand * w * (0.6 + 0.4 * urg);
      perTaskBase[t.id] = baseScore;
      totalBaseScore += baseScore;
      totalDemand += demand;
      weightedDemand += demand * w;
    }
    const aiBaseline = totalDemand === 0 ? 0 : Math.min(1, weightedDemand / totalDemand);

    // Progress-weighted completion: how much of the risk has been burned down
    let progressedScore = 0; // sum(baseScore * progress)
    let blockedCount = 0;
    for (const t of T) {
      const s = states.get(t.id);
      const progress = s?.stage === 'complete' ? 1 : s?.stage === 'execute' ? (Math.max(0, Math.min(100, s.progress ?? 0)) / 100) : 0;
      progressedScore += (perTaskBase[t.id] || 0) * progress;
      if (s?.stage === 'blocked') blockedCount += 1;
    }
    const progressWeighted = totalBaseScore === 0 ? 1 : Math.max(0, Math.min(1, progressedScore / totalBaseScore));
    const blockedRatio = T.length === 0 ? 0 : blockedCount / T.length;

    // Combine into dynamic severity (0..1)
    const sevWeights = (cfg as any)?.assessment?.severityWeights || { aiBaseline: 0.55, inverseProgress: 0.35, blocked: 0.10 };
    const blockedAmp = (cfg as any)?.assessment?.blockedAmplifier ?? 1.5;
    const severity = Math.max(0, Math.min(1,
      (sevWeights.aiBaseline ?? 0.55) * aiBaseline +
      (sevWeights.inverseProgress ?? 0.35) * (1 - progressWeighted) +
      (sevWeights.blocked ?? 0.1) * Math.min(1, blockedRatio * blockedAmp)
    ));

    // Dynamic priorities by base importance (show original scores, not remaining)
    const priorities = [...T].map((t) => {
      const base = perTaskBase[t.id] || 0;
      const s = states.get(t.id);
      const progress = s?.stage === 'complete' ? 1 : s?.stage === 'execute' ? (Math.max(0, Math.min(100, s.progress ?? 0)) / 100) : 0;
      // Show base score for importance, but sort by remaining work
      const remaining = Math.max(0, base * (1 - progress));
      const displayScore = base; // Always show the original importance
      return { id: t.id, category: t.category, demand: t.demand, deadline: t.deadline, score: displayScore, remaining, progress, stage: s?.stage };
    }).sort((a, b) => (b.remaining || 0) - (a.remaining || 0)).slice(0, Math.max(1, Number(((cfg as any)?.topN?.priorities ?? 5))));

    // Risks
    const risks: string[] = [];
    const rTpl = (cfg as any)?.riskTemplates || {};
    if ((p.constraints || []).some((c) => c.type === 'capacity')) risks.push(String(rTpl.capacity || 'Capacity constraints may limit response time'));
    if (T.some((t) => (t.category || '').toLowerCase() === 'power' && (states.get(t.id)?.stage !== 'complete'))) risks.push(String(rTpl.power || 'Power restoration impacts hospitals and shelters'));
    if (T.some((t) => (t.category || '').toLowerCase() === 'hospital' && (states.get(t.id)?.stage !== 'complete'))) risks.push(String(rTpl.hospital || 'ER bed availability may bottleneck triage'));
    if (blockedCount > 0) {
      const msg = String(rTpl.blockedCount || '{count} task(s) blocked due to limited capacity or eligibility');
      risks.push(msg.replace('{count}', String(blockedCount)));
    }
    const imminent = T.filter((t) => (t.deadline ? urgencyOf(t.deadline ?? null) > 0.8 : false) && (states.get(t.id)?.stage !== 'complete')).length;
    if (imminent > 0) {
      const msg = String(rTpl.imminent || '{count} task(s) with imminent deadlines');
      risks.push(msg.replace('{count}', String(imminent)));
    }

    return { severity, risks: risks.slice(0, 4), priorities };
  }

  // Derive per-task state from emitted steps for board + assessment
  const taskStates = useMemo(() => deriveTaskStates(steps, stepIndex, tasks), [steps, stepIndex, tasks]);

  const assessment = useMemo(() => {
    // Only show assessment after simulation has started (stepIndex > 0)
    if (stepIndex === 0 && !running) {
      return { severity: 0, risks: [], priorities: [] };
    }
    const src = (agenticMode && worldState) ? worldState : plan;
    return src ? computeAssessment(src, taskStates) : { severity: 0, risks: [], priorities: [] };
  }, [plan, worldState, agenticMode, taskStates, stepIndex, running]);

  // Build the end-to-end step list for a given plan using the simulator engine
  function buildSteps(p: Plan) {
    const A = (p.actors || []).map(a => ({ ...a }));
    const T = (p.tasks || []).map(t => ({ ...t }));
    const steps: any[] = [];
    steps.push({ type: "assessment", message: "Initial assessment complete. Generating balanced allocations…" });
    A.forEach((a) => steps.push({ type: "revealActor", actorId: a.id }));
    const maxPins = Math.max(0, Number(((cfg as any)?.topN?.revealPins ?? 10)));
    T.slice(0, maxPins).forEach((t) => steps.push({ type: "revealPin", taskId: t.id }));
    const nowSec = Math.floor(Date.now() / 1000);
    const body = buildAssignmentSteps(A as any, T as any, { cfg, agenticMode, nowSec });
    steps.push(...body);
    steps.push({ type: "done", message: "Simulation completed." });
    return steps;
  }

  // Build steps when plan changes
  useEffect(() => {
    if (plan) {
      // establish a fresh base time when a new plan is loaded
      baseTimeRef.current = Math.floor(Date.now() / 1000);
      const s = buildSteps(plan);
      setSteps(s);
      setStepIndex(0);
      setLog([]);
      setActorLoads({}); // Reset actor loads for new plan
    }
  }, [plan]);

  // --- Agentic mode helpers ---
  function simulateRandomEvents(ws: Plan) {
    // small nondeterminism; keep safe and bounded
    if (Math.random() < 0.18) {
      const vol = (ws.actors || []).find((a) => a.id?.toLowerCase?.() === "volunteers");
      if (vol && typeof vol.capacity === 'number') vol.capacity += 5;
    }
    if (Math.random() < 0.08) {
      (ws.tasks = ws.tasks || []).push({
        id: `new_task_${Date.now()}`,
        category: "evac_zone",
        demand: 30,
        deadline: Math.floor(Date.now() / 1000) + 3600,
      } as any);
    }
  }

  function applyAgentDecisions(actor: any, decisions: Array<{ task_id: string; assigned_load: number }>, ws: Plan) {
    const T = ws.tasks || [];
    for (const d of decisions || []) {
      const t = T.find((x) => x.id === d.task_id);
      if (!t) continue;
  const enforceTime = Boolean((cfg as any)?.constraints?.enforceTimeLimit);
  const enforceRes = Boolean((cfg as any)?.constraints?.enforceResourceLimit);
  const enforcePol = Boolean((cfg as any)?.constraints?.enforcePolicyLimit);
      if (enforceTime && isTaskAfterDeadline(t)) {
        setLog((prev) => [`Block: ${actor.id} -> ${t.id} skipped (deadline passed)`, ...prev].slice(0, 60));
        continue;
      }
      if (enforceRes && !hasResourcesFor(actor, t)) {
        setLog((prev) => [`Block: ${actor.id} -> ${t.id} skipped (insufficient resources)`, ...prev].slice(0, 60));
        continue;
      }
      if (enforcePol && violatesPolicy(actor, t)) {
        setLog((prev) => [`Block: ${actor.id} -> ${t.id} skipped (policy)`, ...prev].slice(0, 60));
        continue;
      }
      // In agentic mode, trust the agent's decision and bypass static category checks
      // In non-agentic mode, enforce category eligibility
      if (!agenticMode) {
        if (!actorMatchesCategory(actor, (t as any).category)) continue;
      } else {
        try { console.log(`[Agentic] Trusting ${actor.id} decision to take ${d.assigned_load} of ${t.id}`); } catch {}
        if (!actorMatchesCategory(actor, (t as any).category)) {
          try { console.log(`[Agentic Override] Trusted decision: ${actor.id} took ${t.id} despite category mismatch.`); } catch {}
        }
      }
      const demand = Math.max(0, t.demand ?? 0);
      // Enforce capacity + constraint limit
      const baseCap = Math.max(0, (actor.capacity ?? 0) - (actor.current_load ?? 0));
      const lim = constraintLimitForWS(ws, actor.id);
      const limCap = lim != null ? Math.max(0, lim - (actor.current_load ?? 0)) : baseCap;
      const cap = Math.max(0, Math.min(baseCap, limCap));
      if (demand <= 0 || cap <= 0) continue;
      const clampedLoad = Math.max(0, Math.min(d.assigned_load ?? 0, demand, cap));
      const amt = clampedLoad;
      if (amt <= 0) continue;
      t.demand = demand - amt;
      actor.current_load = (actor.current_load ?? 0) + amt;
      (t as any).status = 'in_progress';
      // mark chosen by for UI
      (t as any)._chosen_by = actor.id;
    }
  }

  const agenticInFlightRef = useRef(false);
  const agentCursorRef = useRef(0);
  const lastAgenticRunRef = useRef(0);
  async function runAgenticStep() {
    if (!agenticMode || !worldState) return false;
    if (agenticInFlightRef.current) return false;
    const now = Date.now();
  const thr = (cfg as any)?.throttle || {};
    const minInterval = Math.max(Number(thr.minIntervalMs ?? 1200), speed * Number(thr.intervalMultiplier ?? 2));
    if (now - lastAgenticRunRef.current < minInterval) return false;
    lastAgenticRunRef.current = now;
    agenticInFlightRef.current = true;
    const ws = JSON.parse(JSON.stringify(worldState)) as Plan;
    simulateRandomEvents(ws);
    if (injectNovelTask && Math.random() < 0.8) {
      const presets: any[] = Array.isArray((cfg as any)?.injectedTasks) ? (cfg as any).injectedTasks : [];
      const pick = presets.length ? presets[Math.floor(Math.random() * presets.length)] : null;
      const nowSec = Math.floor(Date.now() / 1000);
      const injected = pick ? {
        id: `${String(pick.idPrefix || 'novel_task')}_${Date.now()}`,
        category: String(pick.category || 'novel'),
        demand: Number(pick.demand ?? 40),
        deadline: nowSec + Number(pick.deadlineMinutesFromNow ?? 90) * 60,
        // carry optional fields through
        flexible: Boolean((pick as any)?.flexible),
        policy_block: (pick as any)?.policy_block,
        required_resources: (pick as any)?.required_resources,
      } : {
        id: `novel_task_${Date.now()}`,
        category: 'novel',
        demand: 40,
        deadline: nowSec + 90 * 60,
      };
      (ws.tasks = ws.tasks || []).push(injected as any);
    }
    const A = ws.actors || [];
    // Sample a rotating window of actors to limit calls per tick
  const minActors = Math.max(1, Number(((cfg as any)?.throttle?.actorsPerRoundMin ?? 1)));
  const maxActors = Math.max(minActors, Number(((cfg as any)?.throttle?.actorsPerRoundMax ?? 3)));
    const windowSize = Math.max(minActors, Math.min(maxActors, A.length));
    const start = agentCursorRef.current % Math.max(1, A.length);
    const picked: any[] = [];
    for (let i = 0; i < windowSize; i++) picked.push(A[(start + i) % A.length]);
    agentCursorRef.current = (start + windowSize) % Math.max(1, A.length);
    for (const a of picked) {
      try {
        const res = await fetch('/api/agent/decide', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ actor: a, worldState: ws }),
        });
        const data = await res.json().catch(() => null);
        const decisions = (data?.ok && Array.isArray(data.decisions)) ? data.decisions : [];
        applyAgentDecisions(a as any, decisions as any, ws);
        if (decisions.length) {
          setLog((prev) => [`Agent decisions: ${a.id} -> ${decisions.map((d: any) => `${d.task_id}:${d.assigned_load}`).join(', ')}`, ...prev].slice(0, 60));
        }
        if (data?.comment) {
          setLog((prev) => [`Agent insight: ${a.id} — ${String(data.comment)}`, ...prev].slice(0, 60));
        }
      } catch (e) {
        setLog((prev) => [`Agent failed: ${a.id}`, ...prev].slice(0, 60));
      }
    }
    setWorldState(ws);
    agenticInFlightRef.current = false;
    return true;
  }

  function applyStepEffects(st: any) {
    // Apply effects and return log message
    switch (st.type) {
      case "assessment":
        return `Assessment: ${st.message}`;
      case "agentThink":
        return `Agent think: ${st.actorId || 'agent'} on ${st.taskId} — ${st.message || ''}`.trim();
      case "agentAction":
        return `Agent action: ${st.actorId || 'agent'} on ${st.taskId} — ${st.message || ''}`.trim();
      case "agentInsight":
        return `Agent insight: ${st.actorId || 'agent'} on ${st.taskId} — ${(st.insight?.note || '').toString()}`.trim();
      case "assign":
        // Update actor load in separate state to avoid triggering plan rebuild
        if (st.actorId && typeof st.amount === 'number') {
          setActorLoads(prev => ({
            ...prev,
            [st.actorId]: (prev[st.actorId] || 0) + st.amount
          }));
        }
        return `Assign: ${st.actorId} -> ${st.taskId} (${st.amount})`;
      case "execute":
        return `Execute: ${st.taskId} ${st.progress}% (phase ${st.phase}/${st.of})`;
      case "complete":
        return `Complete: ${st.taskId}`;
      case "blocked":
      case "unassigned":
      case "skip":
        return `${st.type.toUpperCase()}: ${st.message}`;
      case "done":
        return `Done: ${st.message}`;
      default:
        return JSON.stringify(st);
    }
  }

  function advance(oneStep = false) {
    setStepIndex((idx) => {
      const next = Math.min(steps.length - 1, idx + 1);
      if (next !== lastLoggedIndexRef.current) {
        const msg = applyStepEffects(steps[next] || {});
        setLog((prev) => [msg, ...prev].slice(0, 60));
        lastLoggedIndexRef.current = next;
      }
      if (oneStep) return next;
      return next;
    });
  }

  // Timer control
  useEffect(() => {
    if (!running) {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    if (timerRef.current) return;
    timerRef.current = window.setInterval(() => {
      setStepIndex((idx) => {
        const next = Math.min(steps.length - 1, idx + 1);
        if (next !== lastLoggedIndexRef.current) {
          const msg = applyStepEffects(steps[next] || {});
          setLog((prev) => [msg, ...prev].slice(0, 60));
          lastLoggedIndexRef.current = next;
        }
        if (next >= steps.length - 1) {
          // stop
          if (timerRef.current) {
            window.clearInterval(timerRef.current);
            timerRef.current = null;
          }
          setRunning(false);
        }
        return next;
      });
      // After applying the local step, optionally run agentic decisions to mutate world state
      if (agenticMode) {
        // fire and forget; do not block the interval too long
        runAgenticStep();
      }
  }, Math.max(300, speed)) as unknown as number;
    return () => {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [running, steps, speed, agenticMode]);

  const current = steps[stepIndex] || {};
  const reveal = useMemo(() => {
    const actors = new Set<string>();
    const pins = new Set<string>();
    for (let i = 0; i <= stepIndex && i < steps.length; i++) {
      const st = steps[i];
      if (st.type === "revealActor" && st.actorId) actors.add(st.actorId);
      if (st.type === "revealPin" && st.taskId) pins.add(st.taskId);
    }
    return { actors, pins };
  }, [steps, stepIndex]);

  return (
    <main className="center">
  <div className="card" style={{ width: "100%", maxWidth: "min(1600px, 96vw)" }}>
        <h1 className="title">CrisisVerse v1.0 — Simulation</h1>
  <p className="subtitle">Review the generated plan; the board and metrics update as the simulation runs.</p>
        <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap", alignItems: 'center' }}>
          <button className="button" onClick={() => (window.location.href = "/")}>back</button>
          <button
            className="button"
            disabled={rerunLoading}
            onClick={async () => {
              // allow re-run using the last prompt if available
              const lastPrompt = sessionStorage.getItem("crisisverse.lastPrompt");
              if (!lastPrompt) return (window.location.href = "/");
              
              setRerunLoading(true);
              try {
                const response = await fetch("/api/simulate", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ prompt: lastPrompt }),
                });
                const data = await response.json();
                if (data?.ok && data?.plan) {
                  sessionStorage.setItem("crisisverse.plan", JSON.stringify(data.plan));
                  // Show success message briefly before reload
                  alert("New plan generated! Page will reload with fresh simulation.");
                  window.location.reload();
                } else {
                  alert("Failed to generate new plan. Please try again.");
                }
              } catch (error) {
                alert("Error generating new plan. Please try again.");
              } finally {
                setRerunLoading(false);
              }
            }}
          >
            {rerunLoading ? "generating new plan..." : "re-run simulation"}
          </button>
          <button className="button" onClick={handleStart} disabled={running}>start</button>
          <button className="button" onClick={() => setRunning(false)} disabled={!running}>pause</button>
          <button className="button" onClick={() => advance(true)}>step</button>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: '#d7e6ff', fontSize: 13 }}>
            <input type="checkbox" checked={agenticMode} onChange={(e) => setAgenticMode(e.target.checked)} />
            agentic mode
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: '#d7e6ff', fontSize: 13 }}>
            <input type="checkbox" checked={injectNovelTask} onChange={(e) => setInjectNovelTask(e.target.checked)} />
            inject novel task
          </label>
          <button className="button" onClick={() => setSettingsOpen(true)}>settings</button>
          <select className="input" style={{ width: 150, height: 40, padding: "6px 10px" }} value={String(speed)} onChange={(e) => setSpeed(parseInt(e.target.value, 10))}>
            <option value="1600">speed: slow</option>
            <option value="1100">speed: normal</option>
            <option value="700">speed: fast</option>
            <option value="400">speed: very fast</option>
          </select>
          <button
            className="button"
            onClick={() => { 
              setStepIndex(0); 
              setLog([]); 
              setRunning(false); 
              setActorLoads({}); // Reset actor loads
              // Reset worldState to original plan to ensure tasks go back to assess
              if (plan) {
                setWorldState(JSON.parse(JSON.stringify(plan)));
              }
            }}
            title="Reset: Restarts current simulation from step 1 (same plan/actors)"
          >
            reset
          </button>
          <button
            className="button"
            onClick={() => {
              // Save current results for comparison
              const currentResults = {
                mode: agenticMode ? 'agentic' : 'deterministic',
                taskStates: Array.from(taskStates.entries()),
                assessment: assessment,
                actorLoads: actors.map(a => ({ id: a.id, load: a.current_load, capacity: a.capacity })),
                completedTasks: Array.from(taskStates.entries()).filter(([_, state]) => state.stage === 'complete').length,
                blockedTasks: Array.from(taskStates.entries()).filter(([_, state]) => state.stage === 'blocked').length,
                timestamp: new Date().toISOString()
              };
              
              if (agenticMode) {
                setComparisonData(prev => ({ ...prev, agenticResults: currentResults }));
              } else {
                setComparisonData(prev => ({ ...prev, deterministicResults: currentResults }));
              }
              
              alert(`${agenticMode ? 'Agentic' : 'Deterministic'} results saved for comparison!`);
            }}
          >
            save results
          </button>
        </div>
        {agenticMode && (
          <div className="card" style={{ padding: 10, marginTop: -8, marginBottom: 8, background: 'rgba(94,234,212,0.10)', borderColor: 'rgba(94,234,212,0.4)' }}>
            <div style={{ color: '#5eead4', fontWeight: 600 }}>Agentic Mode Active</div>
            <div style={{ color: '#9ab', fontSize: 12 }}>Agents may override static category eligibility when selecting tasks.</div>
          </div>
        )}

        {settingsOpen && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 50 }} onClick={() => setSettingsOpen(false)}>
            <div className="card" style={{ position: 'absolute', right: 16, top: 16, width: 420, maxWidth: '96vw', padding: 16 }} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="subtitle" style={{ margin: 0 }}>Settings</div>
                <button className="button" onClick={() => setSettingsOpen(false)}>close</button>
              </div>
              <div style={{ color: '#9ab', fontSize: 12, marginTop: 6 }}>Changes apply only in this session (not saved to disk).</div>
              <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
                <div style={{ fontWeight: 600, marginTop: 4 }}>Throttle</div>
                <label style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: '#9ab', fontSize: 13 }}>Min interval (ms)</span>
                  <input className="input" type="number" value={Number(localConfig?.throttle?.minIntervalMs ?? cfg.throttle?.minIntervalMs ?? 1200)} onChange={(e) => setLocalConfig((prev: any) => ({ ...prev, throttle: { ...(prev?.throttle || {}), minIntervalMs: Number(e.target.value || 0) } }))} style={{ width: 140 }} />
                </label>
                <label style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: '#9ab', fontSize: 13 }}>Actors per round (min)</span>
                  <input className="input" type="number" value={Number(localConfig?.throttle?.actorsPerRoundMin ?? cfg.throttle?.actorsPerRoundMin ?? 1)} onChange={(e) => setLocalConfig((prev: any) => ({ ...prev, throttle: { ...(prev?.throttle || {}), actorsPerRoundMin: Number(e.target.value || 1) } }))} style={{ width: 140 }} />
                </label>
                <label style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: '#9ab', fontSize: 13 }}>Actors per round (max)</span>
                  <input className="input" type="number" value={Number(localConfig?.throttle?.actorsPerRoundMax ?? cfg.throttle?.actorsPerRoundMax ?? 3)} onChange={(e) => setLocalConfig((prev: any) => ({ ...prev, throttle: { ...(prev?.throttle || {}), actorsPerRoundMax: Number(e.target.value || 3) } }))} style={{ width: 140 }} />
                </label>

                <div style={{ fontWeight: 600, marginTop: 6 }}>LLM</div>
                <label style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: '#9ab', fontSize: 13 }}>Temperature</span>
                  <input className="input" type="number" step="0.05" value={Number(localConfig?.llm?.temperature ?? localConfig?.llm?.temperatureAgent ?? cfg.llm?.temperature ?? cfg.llm?.temperatureAgent ?? 0.2)} onChange={(e) => setLocalConfig((prev: any) => ({ ...prev, llm: { ...(prev?.llm || {}), temperature: Number(e.target.value || 0.2) } }))} style={{ width: 140 }} />
                </label>
                <label style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: '#9ab', fontSize: 13 }}>top_p</span>
                  <input className="input" type="number" step="0.05" value={Number(localConfig?.llm?.top_p ?? cfg.llm?.top_p ?? 1)} onChange={(e) => setLocalConfig((prev: any) => ({ ...prev, llm: { ...(prev?.llm || {}), top_p: Number(e.target.value || 1.0) } }))} style={{ width: 140 }} />
                </label>

                <div style={{ fontWeight: 600, marginTop: 6 }}>Top-N</div>
                <label style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: '#9ab', fontSize: 13 }}>Priorities count</span>
                  <input className="input" type="number" value={Number(localConfig?.topN?.priorities ?? cfg.topN?.priorities ?? 5)} onChange={(e) => setLocalConfig((prev: any) => ({ ...prev, topN: { ...(prev?.topN || {}), priorities: Number(e.target.value || 5) } }))} style={{ width: 140 }} />
                </label>

                <div style={{ fontWeight: 600, marginTop: 6 }}>Agent templates (default)</div>
                <label style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 6 }}>
                  <span style={{ color: '#9ab', fontSize: 13 }}>Actions (one per line, supports {`{id}`}, {`{demand}`})</span>
                  <textarea className="input" rows={4} value={
                    (localConfig?.agentTemplates?.default?.actions ?? cfg.agentTemplates?.default?.actions ?? []).join('\n')
                  } onChange={(e) => {
                    const lines = e.target.value.split('\n');
                    setLocalConfig((prev: any) => ({
                      ...prev,
                      agentTemplates: {
                        ...(prev?.agentTemplates || {}),
                        default: { ...(prev?.agentTemplates?.default || {}), actions: lines },
                      },
                    }));
                  }} />
                </label>
                <label style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 6 }}>
                  <span style={{ color: '#9ab', fontSize: 13 }}>Insight template (first is used)</span>
                  <textarea className="input" rows={2} value={
                    (localConfig?.agentTemplates?.default?.insights ?? cfg.agentTemplates?.default?.insights ?? []).join('\n')
                  } onChange={(e) => {
                    const lines = e.target.value.split('\n');
                    setLocalConfig((prev: any) => ({
                      ...prev,
                      agentTemplates: {
                        ...(prev?.agentTemplates || {}),
                        default: { ...(prev?.agentTemplates?.default || {}), insights: lines },
                      },
                    }));
                  }} />
                </label>
                <div style={{ fontWeight: 600, marginTop: 6 }}>Constraints</div>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={Boolean(localConfig?.constraints?.enforceTimeLimit ?? cfg.constraints?.enforceTimeLimit)} onChange={(e) => setLocalConfig((prev: any) => ({ ...prev, constraints: { ...(prev?.constraints || {}), enforceTimeLimit: e.target.checked } }))} />
                  <span style={{ color: '#9ab', fontSize: 13 }}>Enforce time/deadline</span>
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={Boolean(localConfig?.constraints?.enforceResourceLimit ?? cfg.constraints?.enforceResourceLimit)} onChange={(e) => setLocalConfig((prev: any) => ({ ...prev, constraints: { ...(prev?.constraints || {}), enforceResourceLimit: e.target.checked } }))} />
                  <span style={{ color: '#9ab', fontSize: 13 }}>Enforce resource requirements</span>
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={Boolean(localConfig?.constraints?.enforcePolicyLimit ?? cfg.constraints?.enforcePolicyLimit)} onChange={(e) => setLocalConfig((prev: any) => ({ ...prev, constraints: { ...(prev?.constraints || {}), enforcePolicyLimit: e.target.checked } }))} />
                  <span style={{ color: '#9ab', fontSize: 13 }}>Enforce policy blocks</span>
                </label>

                <div style={{ fontWeight: 600, marginTop: 6 }}>Agentic override actors</div>
                <div style={{ display: 'grid', gap: 6 }}>
                  {(actors || []).map((a: any) => (
                    <label key={a.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: 8 }}>
                      <span style={{ color: '#d7e6ff', fontSize: 13 }}>{a.id}</span>
                      <input type="checkbox" checked={Boolean((a as any).agentic_override)} onChange={(e) => {
                        // Session-local toggle: patch worldState/plan actors
                        setWorldState((prev) => {
                          if (!prev?.actors) return prev;
                          return { ...prev, actors: prev.actors.map(x => x.id === a.id ? { ...x, agentic_override: e.target.checked } : x) } as any;
                        });
                      }} />
                    </label>
                  ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
                  <div style={{ color: '#9ab', fontSize: 12 }}>Quick demo</div>
                  <button className="button" onClick={() => {
                    const preset = (cfg as any)?.demoPresets?.immediateOverride;
                    if (!preset) return;
                    const nowSec = Math.floor(Date.now() / 1000);
                    const ws: any = { ...worldState };
                    ws.actors = (preset.actors || []).map((a: any) => ({ ...a }));
                    ws.tasks = (preset.tasks || []).map((t: any) => ({ ...t, deadline: t.deadline ? (nowSec + Math.max(0, Math.round(Number(t.deadline))) * 60) : undefined }));
                    setWorldState(ws);
                    setAgenticMode(true);
                    setLog((prev) => ["Loaded demo preset: immediateOverride", ...prev].slice(0, 60));
                  }}>load override demo</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Comparison Panel */}
        {comparisonOpen && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 50 }} onClick={() => setComparisonOpen(false)}>
            <div className="card" style={{ position: 'absolute', right: 16, top: 16, width: 620, maxWidth: '96vw', padding: 16, maxHeight: '90vh', overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div className="subtitle" style={{ margin: 0 }}>Agentic vs Deterministic Comparison</div>
                <button className="button" onClick={() => setComparisonOpen(false)}>close</button>
              </div>
              
              {(!comparisonData.deterministicResults || !comparisonData.agenticResults) ? (
                <div style={{ color: '#9ab', fontSize: 14, padding: 20, textAlign: 'center' }}>
                  <p>Run both simulations and save results to see comparison:</p>
                  <ol style={{ textAlign: 'left', color: '#d7e6ff', marginTop: 12 }}>
                    <li>Run with <strong>Agentic Mode OFF</strong> → Click "Save Results"</li>
                    <li>Click "Re-run Simulation" (wait for new plan)</li>
                    <li>Run with <strong>Agentic Mode ON</strong> → Click "Save Results"</li>
                    <li>View comparison here</li>
                  </ol>
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 16 }}>
                  {/* Summary Comparison */}
                  <div className="card" style={{ padding: 16, background: 'rgba(94,234,212,0.08)' }}>
                    <div style={{ fontWeight: 600, marginBottom: 12, color: '#5eead4' }}>Key Performance Metrics</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, fontSize: 13 }}>
                      <div style={{ color: '#9ab' }}>Metric</div>
                      <div style={{ color: '#f87171' }}>Deterministic</div>
                      <div style={{ color: '#34d399' }}>Agentic</div>
                      
                      <div>Tasks Completed</div>
                      <div>{comparisonData.deterministicResults?.completedTasks || 0}</div>
                      <div>{comparisonData.agenticResults?.completedTasks || 0}</div>
                      
                      <div>Tasks Blocked</div>
                      <div>{comparisonData.deterministicResults?.blockedTasks || 0}</div>
                      <div>{comparisonData.agenticResults?.blockedTasks || 0}</div>
                      
                      <div>Threat Severity</div>
                      <div>{Math.round((comparisonData.deterministicResults?.assessment?.severity || 0) * 100)}%</div>
                      <div>{Math.round((comparisonData.agenticResults?.assessment?.severity || 0) * 100)}%</div>
                    </div>
                  </div>

                  {/* Improvement Analysis */}
                  <div className="card" style={{ padding: 16 }}>
                    <div style={{ fontWeight: 600, marginBottom: 12 }}>Improvement Analysis</div>
                    {(() => {
                      const detCompleted = comparisonData.deterministicResults?.completedTasks || 0;
                      const agCompleted = comparisonData.agenticResults?.completedTasks || 0;
                      const improvement = agCompleted - detCompleted;
                      const improvementPct = detCompleted > 0 ? Math.round((improvement / detCompleted) * 100) : 0;
                      
                      return (
                        <div style={{ color: improvement > 0 ? '#34d399' : '#f87171', fontSize: 14 }}>
                          {improvement > 0 ? '✅' : '❌'} Agentic mode completed <strong>{improvement}</strong> more tasks 
                          {improvementPct > 0 && ` (+${improvementPct}% improvement)`}
                        </div>
                      );
                    })()}
                  </div>

                  {/* Actor Utilization */}
                  <div className="card" style={{ padding: 16 }}>
                    <div style={{ fontWeight: 600, marginBottom: 12 }}>Actor Utilization</div>
                    <div style={{ display: 'grid', gap: 8 }}>
                      {(comparisonData.deterministicResults?.actorLoads || []).map((actor: any, idx: number) => {
                        const agenticActor = (comparisonData.agenticResults?.actorLoads || []).find((a: any) => a.id === actor.id);
                        return (
                          <div key={actor.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 8, alignItems: 'center', fontSize: 12 }}>
                            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{actor.id}</div>
                            <div style={{ color: '#f87171' }}>Det: {actor.load}/{actor.capacity}</div>
                            <div style={{ color: '#34d399' }}>Ag: {agenticActor?.load || 0}/{agenticActor?.capacity || 0}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
                    <button 
                      className="button" 
                      onClick={() => {
                        setComparisonData({});
                        alert("Comparison data cleared. Run new simulations to compare again.");
                      }}
                    >
                      Clear Results
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Comparison Toggle Button - Fixed Position */}
        {(comparisonData.deterministicResults || comparisonData.agenticResults) && (
          <div 
            style={{ 
              position: 'fixed', 
              right: 16, 
              top: '50%', 
              transform: 'translateY(-50%)', 
              zIndex: 40,
              cursor: 'pointer'
            }}
            onClick={() => setComparisonOpen(!comparisonOpen)}
          >
            <div 
              className="card" 
              style={{ 
                padding: '8px 12px', 
                background: 'rgba(94,234,212,0.12)', 
                borderColor: 'rgba(94,234,212,0.4)',
                fontSize: 12,
                fontWeight: 600,
                color: '#5eead4',
                writingMode: 'vertical-rl',
                textOrientation: 'mixed'
              }}
              title="Click to compare Agentic vs Deterministic results"
            >
              {comparisonOpen ? '→' : '←'} Compare Results
            </div>
          </div>
        )}

  {/* Threat Assessment header */}
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginBottom: 16 }}>
          <div className="card" style={{ padding: 16 }}>
            <div className="subtitle" style={{ margin: 0 }}>Threat severity</div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 12, marginBottom: 8 }}>
              {(() => {
                const severity = Math.round((assessment.severity || 0) * 100);
                const circumference = 2 * Math.PI * 45; // radius = 45
                const strokeDashoffset = circumference - (severity / 100) * circumference;
                return (
                  <div style={{ position: 'relative', width: 100, height: 100 }}>
                    <svg width="100" height="100" style={{ transform: 'rotate(-90deg)' }}>
                      {/* Background circle */}
                      <circle
                        cx="50"
                        cy="50"
                        r="45"
                        stroke="rgba(255,255,255,0.08)"
                        strokeWidth="6"
                        fill="transparent"
                      />
                      {/* Progress circle */}
                      <circle
                        cx="50"
                        cy="50"
                        r="45"
                        stroke={severity < 30 ? '#34d399' : severity < 70 ? '#fbbf24' : '#f87171'}
                        strokeWidth="6"
                        fill="transparent"
                        strokeDasharray={circumference}
                        strokeDashoffset={strokeDashoffset}
                        strokeLinecap="round"
                        style={{ transition: 'stroke-dashoffset 0.5s ease' }}
                      />
                    </svg>
                    <div style={{ 
                      position: 'absolute', 
                      top: '50%', 
                      left: '50%', 
                      transform: 'translate(-50%, -50%)',
                      fontWeight: 600,
                      fontSize: 18,
                      color: severity < 30 ? '#34d399' : severity < 70 ? '#fbbf24' : '#f87171'
                    }}>
                      {severity}%
                    </div>
                  </div>
                );
              })()}
            </div>
            <div style={{ textAlign: 'center', color: '#9ab', fontSize: 12 }}>
              {stepIndex === 0 && !running ? 'Start simulation for assessment' : 'overall impact'}
            </div>
          </div>
          <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div className="subtitle" style={{ margin: 0 }}>Agent Log</div>
              <div style={{ color: '#9ab', fontSize: 12 }}>{log.length} events</div>
            </div>
            <div style={{ flex: 1, overflow: 'auto', display: 'grid', gap: 4, alignContent: 'start', maxHeight: 180 }}>
              {log.length === 0 ? (
                <div style={{ color: '#9ab', fontSize: 12, textAlign: 'center', padding: '10px 0' }}>
                  No agent activity yet...
                  <br />
                  <span style={{ fontSize: 11, opacity: 0.7 }}>Start simulation to see live decisions</span>
                </div>
              ) : (
                log.slice(0, 12).map((l, i) => (
                  <div 
                    key={i} 
                    style={{ 
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace', 
                      fontSize: 10, 
                      color: l.includes('Agent decisions:') ? '#34d399' : 
                             l.includes('Agent insight:') ? '#60a5fa' : 
                             l.includes('Agent failed:') ? '#f87171' : 
                             l.includes('Block:') ? '#fbbf24' : 
                             l.includes('Assessment:') ? '#a78bfa' : '#d7e6ff',
                      background: i < 2 ? 'rgba(94,234,212,0.06)' : 'transparent',
                      padding: '3px 6px',
                      borderRadius: 4,
                      borderLeft: l.includes('Agent decisions:') ? '2px solid #34d399' : 
                                 l.includes('Agent insight:') ? '2px solid #60a5fa' : 
                                 l.includes('Agent failed:') ? '2px solid #f87171' :
                                 l.includes('Block:') ? '2px solid #fbbf24' : 
                                 l.includes('Assessment:') ? '2px solid #a78bfa' : '2px solid transparent',
                      wordBreak: 'break-word',
                      lineHeight: 1.3,
                      transition: 'all 0.2s ease'
                    }}
                    title={l}
                  >
                    {l.length > 60 ? `${l.substring(0, 57)}...` : l}
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="card" style={{ padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="subtitle" style={{ margin: 0 }}>Top priorities</div>
              <div style={{ color: '#9ab', fontSize: 12 }}>by score</div>
            </div>
            <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
              {stepIndex === 0 && !running ? (
                <div style={{ color: '#9ab' }}>Start simulation to view priorities.</div>
              ) : (assessment.priorities || []).length === 0 ? (
                <div style={{ color: '#9ab' }}>No tasks available</div>
              ) : (
                assessment.priorities.map((p: any) => {
                  const cat = (p.category || '').toLowerCase();
                  const color = cat === 'hospital' ? '#f87171' : cat === 'shelter' ? '#fbbf24' : cat === 'evac_zone' ? '#34d399' : cat === 'power' ? '#60a5fa' : '#a78bfa';
                  const score = p.score || 0;
                  const pct = Math.min(100, Math.max(5, Math.round(score * 10))); // Make scores more visible
                  return (
                    <div key={p.id}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>{String(p.id).replace(/_/g, ' ')}</div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ color: '#9ab', fontSize: 11 }}>{score.toFixed(1)}</span>
                          {p.category && <span style={{ background: color, color: '#001018', borderRadius: 999, padding: '2px 8px', fontSize: 12 }}>{p.category}</span>}
                        </div>
                      </div>
                      <div style={{ height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 999 }}>
                        <div style={{ width: `${pct}%`, height: 6, borderRadius: 999, background: 'linear-gradient(90deg, #5eead4, #60a5fa)' }} />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Operations Board */}
        <div className="card" style={{ padding: 16, marginBottom: 20, width: '100%', maxWidth: '100%', boxSizing: 'border-box' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, alignItems: 'start' }}>
            {[
              { key: 'blocked', label: 'Blocked' },
              { key: 'assess', label: 'Assess' },
              { key: 'agent', label: 'Agent' },
              { key: 'assign', label: 'Assign' },
              { key: 'execute', label: 'Execute' },
              { key: 'complete', label: 'Complete' },
            ].map((col) => (
              <div key={col.key} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: 10, minHeight: 200, minWidth: 0, boxSizing: 'border-box', overflow: 'hidden' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ fontWeight: 600 }}>{col.label}</div>
                  <div style={{ color: '#9ab', fontSize: 12 }}>{(Array.from(taskStates.entries()) as Array<[string, TaskState]>).filter(([id, s]) => s.stage === col.key).length}</div>
                </div>
                <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
                  {(Array.from(taskStates.entries()) as Array<[string, TaskState]>).filter(([id, s]) => s.stage === col.key).map(([id, s]) => {
                    const t = tasks.find((x) => x.id === id);
                    if (!t) return null; // task might not exist in current tasks array (e.g., during plan refresh)
                    const cat = (t as any).category as string | undefined;
                    const badgeColor = cat === 'hospital' ? '#f87171' : cat === 'shelter' ? '#fbbf24' : cat === 'evac_zone' ? '#34d399' : cat === 'power' ? '#60a5fa' : '#a78bfa';
                    const isActive = current.taskId === id;
                    const actorById = new Map(actors.map(a => [a.id, a] as const));
                    // deadline breach highlighting
                    const nowSec = Math.floor(Date.now()/1000);
                    const missed = !!t.deadline && nowSec > (Number(t.deadline) > 1e7 ? Number(t.deadline) : (baseTimeRef.current + Math.max(0, Math.round(Number(t.deadline))) * 60)) && s.stage !== 'complete';
                    return (
                      <div key={id} style={{ position: 'relative', background: isActive ? 'rgba(94,234,212,0.16)' : 'rgba(255,255,255,0.04)', border: `2px solid ${missed ? 'rgba(248,113,113,0.85)' : (isActive ? 'rgba(94,234,212,0.6)' : 'rgba(255,255,255,0.10)')}`, borderRadius: 10, padding: 10, animation: 'pop-in 320ms ease both', width: '100%', maxWidth: '100%', boxSizing: 'border-box', overflow: 'hidden' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{id.replace(/_/g, ' ')}</div>
                          {cat && <span style={{ background: badgeColor, color: '#001018', borderRadius: 999, padding: '2px 8px', fontSize: 12, maxWidth: '28%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cat}</span>}
                        </div>
                        <div style={{ color: '#9ab', fontSize: 12, marginTop: 4, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>Demand: {t.demand ?? '-'}{t.deadline ? ` • DL: ${formatDeadlineStable(t.deadline as number)}` : ''}</div>
                        {s.stage === 'blocked' && (
                          <div style={{ marginTop: 6 }}>
                            <div style={{ color: '#f87171', fontSize: 12, overflowWrap: 'anywhere' }}>{s.message || 'Task cannot proceed due to capacity/eligibility'}</div>
                            <div style={{ marginTop: 4 }}>
                              <button
                                className="button"
                                style={{ padding: '2px 8px', fontSize: 12, height: 26 }}
                                onMouseEnter={() => setWhyOpen(id)}
                                onMouseLeave={() => setWhyOpen((prev) => (prev === id ? null : prev))}
                              >
                                why blocked?
                              </button>
                              {whyOpen === id && (
                                <div
                                  style={{ position: 'absolute', zIndex: 20, right: 10, top: 36, background: 'rgba(0,10,20,0.96)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 8, padding: 10, width: 280, boxShadow: '0 8px 22px rgba(0,0,0,0.35)' }}
                                  onMouseEnter={() => setWhyOpen(id)}
                                  onMouseLeave={() => setWhyOpen((prev) => (prev === id ? null : prev))}
                                >
                                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Details</div>
                                  {!s.details && <div style={{ color: '#9ab', fontSize: 12 }}>No further details available.</div>}
                                  {s.details?.reason === 'no_capable' && (
                                    <div style={{ color: '#d7e6ff', fontSize: 12 }}>
                                      No eligible actors matched category {(t as any).category ? `'${(t as any).category}'` : '(unspecified)'}.
                                    </div>
                                  )}
                                  {s.details?.reason === 'at_capacity' && (
                                    <div style={{ display: 'grid', gap: 6 }}>
                                      <div style={{ color: '#9ab', fontSize: 12 }}>Eligible actors are at or below constraint limits:</div>
                                      {(s.details?.perActor || []).map((pa: any, idx: number) => {
                                        const act = actorById.get(pa.actorId) || {} as any;
                                        return (
                                          <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center', fontSize: 12 }}>
                                            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pa.actorId}</div>
                                            <div style={{ color: '#9ab', textAlign: 'right' }}>avail {pa.finalAvail} / cap {act.capacity ?? '-'}{pa.constraintLimit != null ? ` (limit ${pa.constraintLimit})` : ''}</div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                  {s.details?.reason === 'unmet_remainder' && (
                                    <div style={{ display: 'grid', gap: 6 }}>
                                      <div style={{ color: '#9ab', fontSize: 12 }}>After proportional allocation, remaining unmet demand: <span style={{ color: '#e6f0ff' }}>{s.details.remaining}</span></div>
                                      <div style={{ color: '#9ab', fontSize: 12 }}>Per-actor availability snapshot:</div>
                                      {(s.details?.perActor || []).map((pa: any, idx: number) => (
                                        <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center', fontSize: 12 }}>
                                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pa.actorId}</div>
                                          <div style={{ color: '#9ab', textAlign: 'right' }}>avail {pa.finalAvail}</div>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                        {agenticMode && (t as any)._chosen_by && (s.stage === 'assign' || s.stage === 'execute') && (
                          <div style={{ marginTop: 6, color: '#9ab', fontSize: 12 }}>Chosen by {(t as any)._chosen_by}</div>
                        )}
                        {s.stage === 'agent' && (
                          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ width: 12, height: 12, border: '2px solid rgba(94,234,212,0.5)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                            <div style={{ color: '#d7e6ff', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.message || 'analyzing…'}</div>
                          </div>
                        )}
                        {s.stage === 'execute' && (
                          <div style={{ marginTop: 8 }}>
                            <div style={{ height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 999 }}>
                              <div style={{ width: `${s.progress || 0}%`, height: 6, borderRadius: 999, background: 'linear-gradient(90deg, #5eead4, #60a5fa)' }} />
                            </div>
                            {s.actors && <div style={{ color: '#9ab', fontSize: 12, marginTop: 4, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>actors: {s.actors.join(', ')}</div>}
                          </div>
                        )}
                        {s.stage === 'complete' && (
                          <div style={{ marginTop: 6, color: '#34d399', fontSize: 12, fontWeight: 600 }}>Completed</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Panels below diagram */}
  <div style={{ display: "grid", gap: 20 }}>
            <div className="card" style={{ padding: 16 }}>
              <div className="subtitle" style={{ margin: 0 }}>Actor Load</div>
              <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
                {actors.length === 0 ? (
                  <div style={{ color: '#9ab' }}>No actors.</div>
                ) : (
                  actors.map((a: any) => {
                    const cap = Math.max(0, a.capacity ?? 0);
                    const load = Math.max(0, Math.min(cap, a.current_load ?? 0));
                    const pct = cap > 0 ? Math.round((load / cap) * 100) : 0;
                    return (
                      <div key={a.id}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{a.id}</div>
                          <div style={{ color: '#9ab' }}>{load}/{cap}</div>
                        </div>
                        <div style={{ height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 999 }}>
                          <div style={{ width: `${pct}%`, height: 6, borderRadius: 999, background: 'linear-gradient(90deg, #fbbf24, #f87171)' }} />
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
            <div className="card" style={{ padding: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div className="subtitle" style={{ margin: 0 }}>Simulation Timeline</div>
                <div style={{ color: "#9ab", fontSize: 12 }}>step {stepIndex + 1} / {Math.max(1, steps.length)}</div>
              </div>
              <div style={{ height: 8, background: "rgba(255,255,255,0.08)", borderRadius: 999, marginTop: 8 }}>
                <div style={{ width: `${steps.length ? Math.round((stepIndex / (steps.length - 1)) * 100) : 0}%`, height: 8, background: "linear-gradient(90deg, #5eead4, #60a5fa)", borderRadius: 999 }} />
              </div>
            </div>

            <div className="subtitle" style={{ marginBottom: 0 }}>Objectives</div>
            <div className="card" style={{ padding: 20 }}>
              {(stepIndex === 0 && !running) ? (
                <div style={{ color: "#9ab" }}>Start simulation to view objectives progress.</div>
              ) : plan?.objectives ? (
                <div style={{ display: "grid", gap: 8 }}>
                  {Object.entries(plan.objectives).map(([k, v]) => (
                    <div key={k} style={{ display: "grid", gridTemplateColumns: "110px 1fr 40px", gap: 8, alignItems: "center" }}>
                      <div style={{ color: "#9ab", textTransform: "capitalize" }}>{k}</div>
                      <div style={{ height: 8, background: "rgba(255,255,255,0.08)", borderRadius: 999 }}>
                        <div style={{ width: `${Math.min(100, Math.max(0, (v as number) * 100))}%`, height: 8, background: "linear-gradient(90deg, #5eead4, #60a5fa)", borderRadius: 999 }} />
                      </div>
                      <div style={{ color: "#e6f0ff", fontSize: 12, textAlign: "right" }}>{(v as number).toFixed(2)}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ color: "#9ab" }}>No objectives provided.</div>
              )}
            </div>

            <div className="subtitle" style={{ marginBottom: 0 }}>Constraints</div>
            <div className="card" style={{ padding: 20, display: "grid", gap: 10 }}>
              {(plan?.constraints ?? []).length === 0 && (
                <div style={{ color: "#9ab" }}>No constraints provided.</div>
              )}
              {(plan?.constraints ?? []).map((c, idx) => (
                <div key={idx} style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                  <span style={{ fontSize: 12, padding: "2px 8px", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 999, color: "#d7e6ff" }}>{c.type}</span>
                  <span style={{ color: "#9ab", flex: 1 }}>{c.actor}</span>
                  {typeof c.limit === "number" && <span style={{ color: "#e6f0ff" }}>{c.limit}</span>}
                </div>
              ))}
            </div>

            <div className="subtitle" style={{ marginBottom: 0 }}>Tasks</div>
            {(tasks.length === 0) && <div style={{ color: "#9ab" }}>No tasks in plan.</div>}
            {tasks.map((t) => (
              <div key={t.id} className="card" style={{ padding: 18 }}
                onMouseEnter={(e) => setHover({ x: e.clientX, y: e.clientY, content: JSON.stringify(t, null, 2) })}
                onMouseLeave={() => setHover(null)}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontWeight: 600 }}>{t.id.replace(/_/g, " ")}</div>
                  {(t as any).category && <span style={{ fontSize: 12, padding: "2px 8px", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 999, color: "#d7e6ff" }}>{(t as any).category}</span>}
                </div>
                <div style={{ color: "#9ab", fontSize: 13, marginTop: 6 }}>Demand: {t.demand ?? "-"} • Deadline: {t.deadline ? formatDeadlineStable(t.deadline as number) : "-"} {t.actor ? `• Actor: ${t.actor}` : ""}</div>
                {current.type && current.taskId === t.id && (
                  <div style={{ marginTop: 10, height: 6, background: "rgba(255,255,255,0.08)", borderRadius: 999 }}>
                    <div style={{ width: `${current.progress ?? (current.type === 'complete' ? 100 : 0)}%`, height: 6, background: "linear-gradient(90deg, #5eead4, #60a5fa)", borderRadius: 999 }} />
                  </div>
                )}
              </div>
            ))}
        </div>
      </div>
    </main>
  );
}
