import { describe, it, expect } from 'vitest';
import { buildAssignmentSteps, type Actor, type Task } from '@/lib/simulator';

const baseCfg = {
  constraints: {
    enforceTimeLimit: false,
    enforceResourceLimit: false,
    enforcePolicyLimit: false,
  },
  throttle: { overrideCapPerRound: 2 },
  categoryWeights: { hospital: 1, evac_zone: 0.9, hazardous_material: 0.8 },
};

function stepsOf(type: string, steps: any[]) {
  return steps.filter(s => s.type === type);
}

describe('simulator - proactive overrides', () => {
  it('uses agentic override when no eligible defaults exist', () => {
    const actors: Actor[] = [
      { id: 'fire_department', capabilities: ['hazardous_material'], capacity: 2, current_load: 0 },
      { id: 'generalist', skills: ['generalist'], capacity: 10, current_load: 0, agentic_override: true },
    ];
    const tasks: Task[] = [
      { id: 'evacuate_workers', category: 'evac_zone', demand: 5 }, // no direct default capability
    ];
    const steps = buildAssignmentSteps(actors, tasks, { cfg: baseCfg, agenticMode: true, nowSec: 1_700_000_000 });
    const overrideLogs = steps.filter(s => s.type === 'agentAction' && String(s.message || '').toLowerCase().includes('override'));
    expect(overrideLogs.length).toBeGreaterThan(0);
    const assigns = stepsOf('assign', steps);
    expect(assigns.length).toBeGreaterThan(0);
    const assignedToGeneralist = assigns.some(a => a.actorId === 'generalist');
    expect(assignedToGeneralist).toBe(true);
  });

  it('prefers agentic actor when default best is near capacity (>=80%)', () => {
    const actors: Actor[] = [
      { id: 'emergency_team', capabilities: ['evac_zone'], capacity: 10, current_load: 8 }, // 80% utilized
      { id: 'generalist', skills: ['generalist'], capacity: 10, current_load: 0, agentic_override: true },
    ];
    const tasks: Task[] = [
      { id: 'evacuate_workers', category: 'evac_zone', demand: 5 },
    ];
    const steps = buildAssignmentSteps(actors, tasks, { cfg: baseCfg, agenticMode: true, nowSec: 1_700_000_000 });
    const overrideLogs = steps.filter(s => s.type === 'agentAction' && String(s.message || '').toLowerCase().includes('override'));
    expect(overrideLogs.length).toBeGreaterThan(0);
    const assigns = stepsOf('assign', steps);
    const assignedToGeneralist = assigns.some(a => a.actorId === 'generalist');
    expect(assignedToGeneralist).toBe(true);
  });

  it('enqueues for retry when unmet demand remains and may assign on retry', () => {
    const actors: Actor[] = [
      { id: 'team_a', capabilities: ['evac_zone'], capacity: 2, current_load: 2 }, // at capacity
      { id: 'generalist', skills: ['generalist'], capacity: 1, current_load: 0, agentic_override: true },
    ];
    const tasks: Task[] = [
      { id: 'evacuate_workers', category: 'evac_zone', demand: 3 },
    ];
    const steps = buildAssignmentSteps(actors, tasks, { cfg: baseCfg, agenticMode: true, nowSec: 1_700_000_000 });
    const blocked = stepsOf('blocked', steps);
    // There could be a blocked step first, and then a retry attempt with assignment to generalist
    const assigns = stepsOf('assign', steps);
    expect(blocked.length + assigns.length).toBeGreaterThan(0);
  });
});
