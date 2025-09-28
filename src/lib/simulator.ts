// Core assignment engine for CrisisVerse
// Builds assignment steps given actors, tasks, config, and mode.

export type Actor = {
  id: string;
  capabilities?: string[];
  skills?: string[];
  capacity?: number;
  current_load?: number;
  resources?: Record<string, number>;
  agentic_override?: boolean;
  policy_block?: boolean;
};

export type Task = {
  id: string;
  demand?: number;
  deadline?: number; // epoch seconds or minutes-from-now
  actor?: string;
  category?: string;
  flexible?: boolean;
  required_resources?: Record<string, number>;
  policy_block?: boolean;
};

export type AssignmentOptions = {
  cfg?: any;
  agenticMode?: boolean;
  nowSec?: number;
};

function getActorAvail(a: Actor) {
  const cap = typeof a.capacity === 'number' ? a.capacity : 0;
  const load = typeof a.current_load === 'number' ? a.current_load : 0;
  return Math.max(0, cap - load);
}

function actorMatchesTask(cfg: any, actor: Actor, task: Task) {
  const category = (task?.category || '').toLowerCase();
  const reqSkills: string[] = cfg?.categorySkills?.[category] || [];
  const caps = ([] as string[])
    .concat(actor?.capabilities || [])
    .concat((actor as any)?.skills || [])
    .map((c: string) => c.toLowerCase());
  // If config defines category -> skills, use that mapping
  if (reqSkills.length > 0) {
    return caps.includes('generalist') || reqSkills.some((s) => caps.includes(String(s).toLowerCase()));
  }
  // Fallbacks when no mapping: allow match if actor has skill matching task id or category, or is generalist
  const byTaskId = caps.includes(String(task.id || '').toLowerCase());
  const byCategory = category ? caps.includes(category) : true;
  return caps.includes('generalist') || byTaskId || byCategory;
}

// Strict default eligibility (no 'generalist' fallback)
function defaultEligible(cfg: any, actor: Actor, task: Task) {
  const category = (task?.category || '').toLowerCase();
  const reqSkills: string[] = cfg?.categorySkills?.[category] || [];
  const caps = ([] as string[])
    .concat(actor?.capabilities || [])
    .concat((actor as any)?.skills || [])
    .map((c: string) => c.toLowerCase());
  if (reqSkills.length > 0) {
    return reqSkills.some((s) => caps.includes(String(s).toLowerCase()));
  }
  const byTaskId = caps.includes(String(task.id || '').toLowerCase());
  const byCategory = category ? caps.includes(category) : false;
  return byTaskId || byCategory; // note: no generalist catch-all here
}

function isTaskAfterDeadline(cfg: any, task: Task, nowSec: number) {
  const tCfg: any = cfg?.constraints?.time || {};
  const flexField = tCfg.flexibleField || 'flexible';
  const isFlexible = Boolean((task as any)?.[flexField]);
  if (isFlexible) return false;
  const dl = Number((task as any)?.deadline);
  if (!dl || isNaN(dl)) return false;
  const target = dl > 1e7 ? dl : (nowSec + Math.max(0, Math.round(dl)) * 60);
  return nowSec > target;
}

function hasResourcesFor(cfg: any, actor: Actor, task: Task) {
  const rCfg: any = cfg?.constraints?.resource || {};
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

function violatesPolicy(cfg: any, actor: Actor, task: Task) {
  const pCfg: any = cfg?.constraints?.policy || {};
  const aField = pCfg.actorField || 'policy_block';
  const tField = pCfg.taskField || 'policy_block';
  const ab = Boolean((actor as any)?.[aField]);
  const tb = Boolean((task as any)?.[tField]);
  return ab || tb;
}

function getAgentActions(cfg: any, task: Task) {
  const id = (task.id || '').replace(/_/g, ' ');
  const cat = (task.category || '').toLowerCase();
  const tpl = (cfg?.agentTemplates?.[cat]) || (cfg?.agentTemplates?.default) || {};
  const actionsTpl: string[] = Array.isArray(tpl.actions) ? tpl.actions : [
    `Breaking down task {id}…`,
    `Gathering context for {id} (demand {demand})…`,
    `Coordinating with stakeholders for {id}…`,
  ];
  const insightsTpl: string[] = Array.isArray(tpl.insights) ? tpl.insights : [
    `Resources identified for {id}; starting in {startIn} min`,
  ];
  const vars: Record<string, string | number> = {
    id,
    demand: Math.max(0, task.demand ?? 0),
    startIn: 20 + Math.floor(Math.random() * 40),
  };
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
  const actions = actionsTpl.map(fill);
  const insightNote = fill(insightsTpl[0] || 'Updated status for {id}');
  const factor = 0.85 + Math.random() * 0.1;
  const kind = cat || 'generic';
  return { actions, insight: { kind, note: insightNote, factor } };
}

export function buildAssignmentSteps(actors: Actor[], tasks: Task[], opts: AssignmentOptions = {}) {
  const cfg = opts.cfg || {};
  const agenticMode = Boolean(opts.agenticMode);
  const nowSec = typeof opts.nowSec === 'number' ? opts.nowSec : Math.floor(Date.now() / 1000);

  const A = (actors || []).map(a => ({ ...a }));
  const T = (tasks || []).map(t => ({ ...t }));
  const steps: any[] = [];

  const catWeight: Record<string, number> = cfg?.categoryWeights || { hospital: 1.0, power: 0.9, evac_zone: 0.85, shelter: 0.8, comms: 0.7 };
  const urgencyOf = (dl?: number | null) => {
    if (!dl || isNaN(Number(dl))) return 0.5;
    const deadline = Number(dl);
    const target = deadline > 1e7 ? deadline : (nowSec + Math.max(0, Math.round(deadline)) * 60);
    return Math.max(0.1, Math.min(1, 1 / Math.max(0.5, (target - nowSec) / 3600)));
  };
  const priorityScore = (t: any) => (Math.max(0, t.demand ?? 0)) * (catWeight[(t.category || '').toLowerCase()] ?? 0.6) * (0.6 + 0.4 * urgencyOf(t.deadline));
  const busyHighPriority = new Set<string>();
  const looseMatch = (actor: any, task: any) => actorMatchesTask(cfg, actor, task);
  const isNearCapacity = (actor: any) => {
    const cap = Math.max(0, actor?.capacity ?? 0);
    const load = Math.max(0, actor?.current_load ?? 0);
    return cap > 0 ? (load / cap) >= 0.8 : true;
  };
  const freeCapacityRatio = (actor: any) => {
    const cap = Math.max(0, actor?.capacity ?? 0);
    const load = Math.max(0, actor?.current_load ?? 0);
    return cap > 0 ? (cap - load) / cap : 0;
  };
  const overrideCap = Math.max(1, Number(cfg?.throttle?.overrideCapPerRound ?? 2));
  const overrideCount = new Map<string, number>();

  const enforceTime = Boolean(cfg?.constraints?.enforceTimeLimit);
  const enforceRes = Boolean(cfg?.constraints?.enforceResourceLimit);
  const enforcePol = Boolean(cfg?.constraints?.enforcePolicyLimit);

  const retryQueue: Task[] = [];

  for (const task of T) {
    const demand = typeof task.demand === 'number' ? task.demand : 0;
    if (demand <= 0) {
      steps.push({ type: 'skip', taskId: task.id, message: `No demand for ${task.id}, skipping.` });
      continue;
    }

    if (enforceTime && isTaskAfterDeadline(cfg, task, nowSec)) {
      steps.push({ type: 'blocked', taskId: task.id, message: `Task ${task.id} missed deadline and is not flexible.`, details: { reason: 'deadline_passed' } });
      continue;
    }

  let candidates = A.filter((a) => defaultEligible(cfg, a, task));
    if (enforceRes) candidates = candidates.filter((a) => hasResourcesFor(cfg, a, task));
    if (enforcePol) candidates = candidates.filter((a) => !violatesPolicy(cfg, a, task));
    if (task.actor) candidates = candidates.filter((a) => a.id === task.actor);

    if (candidates.length === 0) {
      if (agenticMode) {
        // choose an override actor proactively
        const agenticActors = A.filter((a) => a.agentic_override === true && freeCapacityRatio(a) >= 0.10 && looseMatch(a, task) && !busyHighPriority.has(a.id) && (overrideCount.get(a.id) ?? 0) < overrideCap);
        if (agenticActors.length > 0) {
          const best = [...agenticActors].sort((a, b) => freeCapacityRatio(b) - freeCapacityRatio(a))[0];
          candidates = [best];
          overrideCount.set(best.id, (overrideCount.get(best.id) ?? 0) + 1);
          steps.push({ type: 'agentAction', taskId: task.id, actorId: best.id, message: `Agentic override: ${best.id} assigned to ${task.id} due to no eligible default actors` });
        }
      }
      if (candidates.length === 0) {
        steps.push({ type: 'unassigned', taskId: task.id, message: `No capable actor for ${task.id}.`, details: { reason: 'no_capable', category: task.category, candidates: [] } });
        retryQueue.push(task);
        continue;
      }
    }

    const lead = candidates[0];
    const { actions, insight } = getAgentActions(cfg, task);
    steps.push({ type: 'agentThink', taskId: task.id, actorId: lead.id, message: actions[0] });
    actions.slice(1).forEach((msg: string) => steps.push({ type: 'agentAction', taskId: task.id, actorId: lead.id, message: msg }));
    steps.push({ type: 'agentInsight', taskId: task.id, actorId: lead.id, insight });

    if (agenticMode && candidates.length > 0) {
      const defaultBest = [...candidates].sort((a, b) => getActorAvail(b) - getActorAvail(a))[0];
      if (isNearCapacity(defaultBest)) {
        const agenticActors = A.filter((a) => a.agentic_override === true && freeCapacityRatio(a) >= 0.10 && looseMatch(a, task) && !busyHighPriority.has(a.id) && (overrideCount.get(a.id) ?? 0) < overrideCap);
        const filtered = agenticActors.filter((a) => a.id !== defaultBest.id);
        if (filtered.length > 0) {
          const best = [...filtered].sort((a, b) => freeCapacityRatio(b) - freeCapacityRatio(a))[0];
          candidates = [best, ...candidates.filter((c) => c.id !== best.id)];
          overrideCount.set(best.id, (overrideCount.get(best.id) ?? 0) + 1);
          steps.push({ type: 'agentAction', taskId: task.id, actorId: best.id, message: `Agentic override: ${best.id} considered for ${task.id} because ${defaultBest.id} near capacity` });
        }
      }
    }

    const availListRaw = candidates.map((a) => {
      const baseAvail = getActorAvail(a);
      // We can add capacity constraints later if needed; for now use baseAvail
      const capAvail = baseAvail;
      const finalAvail = Math.max(0, Math.min(baseAvail, capAvail));
      return { a, baseAvail, capAvail, avail: finalAvail };
    });
    const availList = availListRaw.filter(x => x.avail > 0);

    if (availList.length === 0) {
      if (agenticMode) {
        const defaultBest = [...candidates].sort((a, b) => getActorAvail(b) - getActorAvail(a))[0];
        const agenticActors = A.filter((a) => a.agentic_override === true && freeCapacityRatio(a) >= 0.10 && looseMatch(a, task) && !busyHighPriority.has(a.id) && getActorAvail(a) > 0 && (overrideCount.get(a.id) ?? 0) < overrideCap);
        if (agenticActors.length > 0) {
          const best = [...agenticActors].sort((a, b) => freeCapacityRatio(b) - freeCapacityRatio(a))[0];
          overrideCount.set(best.id, (overrideCount.get(best.id) ?? 0) + 1);
          steps.push({ type: 'agentAction', taskId: task.id, actorId: best.id, message: `Agentic override: ${best.id} assigned to ${task.id} due to ${defaultBest?.id || 'all defaults'} at capacity` });
          const baseAvail = getActorAvail(best);
          if (baseAvail > 0) {
            const amt = Math.min(baseAvail, demand);
            steps.push({ type: 'assign', taskId: task.id, actorId: best.id, amount: amt, category: task.category });
            if (priorityScore(task) >= 0.5) busyHighPriority.add(best.id);
            const phases = (Array.isArray(cfg?.phases) && cfg.phases.length > 0) ? cfg.phases : [0.33, 0.66, 1.0];
            (phases as number[]).forEach((p: number, i: number) => {
              steps.push({ type: 'execute', taskId: task.id, progress: Math.round(p * 100), phase: i + 1, of: phases.length, actors: [best.id] });
            });
            steps.push({ type: 'complete', taskId: task.id });
            continue;
          }
        }
      }
      steps.push({ type: 'blocked', taskId: task.id, message: `All capable actors at capacity for ${task.id}.`, details: { reason: 'at_capacity', category: task.category, perActor: availListRaw.map(x => ({ actorId: x.a.id, baseAvail: x.baseAvail, capAvail: x.capAvail, finalAvail: x.avail })) } });
      retryQueue.push(task);
      continue;
    }

    const totalAvail = availList.reduce((s, x) => s + x.avail, 0);
    let remaining = demand;
    const allocations: Array<{ actorId: string; amount: number }> = [];
    for (const { a, avail } of availList) {
      const part = Math.round((avail / totalAvail) * demand);
      const amt = Math.min(part, remaining);
      if (amt > 0) {
        allocations.push({ actorId: a.id, amount: amt });
        remaining -= amt;
        if (priorityScore(task) >= 0.5) busyHighPriority.add(a.id);
      }
    }
    if (remaining > 0 && allocations.length > 0) {
      const best = availList[0];
      const current = allocations.find(a => a.actorId === best.a.id);
      if (current) {
        const maxExtra = Math.max(0, best.avail - current.amount);
        const add = Math.min(remaining, maxExtra);
        current.amount += add;
        remaining -= add;
      }
    }
    if (remaining > 0) {
      steps.push({ type: 'blocked', taskId: task.id, message: `Unmet demand of ${remaining} due to capacity limits.`, details: { reason: 'unmet_remainder', remaining, allocations: allocations.slice(), perActor: availList.map(x => ({ actorId: x.a.id, finalAvail: x.avail })) } });
    }

    allocations.forEach((al) => {
      steps.push({ type: 'assign', taskId: task.id, actorId: al.actorId, amount: al.amount, category: task.category });
    });
    const phases = (Array.isArray(cfg?.phases) && cfg.phases.length > 0) ? cfg.phases : [0.33, 0.66, 1.0];
    (phases as number[]).forEach((p: number, i: number) => {
      steps.push({ type: 'execute', taskId: task.id, progress: Math.round(p * 100), phase: i + 1, of: phases.length, actors: allocations.map(a => a.actorId) });
    });
    steps.push({ type: 'complete', taskId: task.id });
  }

  // Retry pass
  if (retryQueue.length > 0) {
    for (const task of retryQueue) {
      const demand = Math.max(0, Number(task.demand ?? 0));
      if (demand <= 0) continue;
  let candidates = A.filter((a) => defaultEligible(cfg, a, task));
      if (agenticMode) {
        const defaultBest = [...candidates].sort((a, b) => getActorAvail(b) - getActorAvail(a))[0];
        if (!defaultBest || (defaultBest && (getActorAvail(defaultBest) <= (defaultBest.capacity ?? 0) * 0.2))) {
          const agenticActors = A.filter((a) => a.agentic_override === true && freeCapacityRatio(a) >= 0.10 && looseMatch(a, task) && !busyHighPriority.has(a.id) && (overrideCount.get(a.id) ?? 0) < overrideCap);
          if (agenticActors.length > 0) {
            const best = [...agenticActors].sort((a, b) => freeCapacityRatio(b) - freeCapacityRatio(a))[0];
            candidates = [best, ...candidates.filter(c => c.id !== best.id)];
            overrideCount.set(best.id, (overrideCount.get(best.id) ?? 0) + 1);
            steps.push({ type: 'agentAction', taskId: task.id, actorId: best.id, message: `Agentic override(retry): ${best.id} considered for ${task.id}` });
          }
        }
      }
      const availListRaw = candidates.map((a) => {
        const baseAvail = getActorAvail(a);
        const finalAvail = Math.max(0, baseAvail);
        return { a, avail: finalAvail };
      });
      const availList = availListRaw.filter(x => x.avail > 0);
      if (availList.length === 0) {
        steps.push({ type: 'blocked', taskId: task.id, message: `Retry blocked: no capacity for ${task.id}`, details: { reason: 'retry_no_capacity' } });
        continue;
      }
      const totalAvail = availList.reduce((s, x) => s + x.avail, 0);
      let remaining = demand;
      const allocations: Array<{ actorId: string; amount: number }> = [];
      for (const { a, avail } of availList) {
        const part = Math.round((avail / totalAvail) * demand);
        const amt = Math.min(part, remaining);
        if (amt > 0) { allocations.push({ actorId: a.id, amount: amt }); remaining -= amt; }
      }
      allocations.forEach((al) => steps.push({ type: 'assign', taskId: task.id, actorId: al.actorId, amount: al.amount, category: task.category }));
      const phases = (Array.isArray(cfg?.phases) && cfg.phases.length > 0) ? cfg.phases : [0.33, 0.66, 1.0];
      (phases as number[]).forEach((p: number, i: number) => {
        steps.push({ type: 'execute', taskId: task.id, progress: Math.round(p * 100), phase: i + 1, of: phases.length, actors: allocations.map(a => a.actorId) });
      });
      steps.push({ type: 'complete', taskId: task.id });
    }
  }

  return steps;
}
