import { describe, it, expect } from 'vitest';
import { buildAssignmentSteps, type Actor, type Task } from '@/lib/simulator';
import simCfg from '@/config/simulation.json';

function stepsOf(type: string, steps: any[]) {
  return steps.filter((s) => s.type === type);
}

function assignsFor(taskId: string, steps: any[]) {
  return steps.filter((s) => s.type === 'assign' && s.taskId === taskId);
}

describe('agentic mode differentiation on heatwave+cyberattack scenario', () => {
  const nowSec = 1_700_000_000; // fixed time for deterministic tests

  // Actors inspired by scenario; tuned to reveal differences
  const actorsBase: Actor[] = [
    // Power utility crews are at capacity (non-agentic cannot assign)
    { id: 'utility_crews', capabilities: ['power'], capacity: 2, current_load: 2, resources: { crews: 1, transformers: 0 } },
    // Evac team is near capacity (>=80%)
    { id: 'evac_team', capabilities: ['evac'], capacity: 5, current_load: 4 },
    // Hazmat team has a policy block (non-agentic filtered out)
    { id: 'hazmat_team', capabilities: ['hazardous_material'], capacity: 3, current_load: 0, policy_block: true },
    // Generalist is only used by agentic override
    { id: 'generalist', skills: ['generalist'], capacity: 6, current_load: 0, agentic_override: true },
  ];

  const tasks: Task[] = [
    {
      id: 'restore_hospital_power_1',
      category: 'power',
      demand: 3,
      deadline: 60, // minutes-from-now
      required_resources: { crews: 2, transformers: 1 },
      flexible: false,
    },
    {
      id: 'contain_hazmat_substation_1',
      category: 'hazmat',
      demand: 1,
      deadline: 75,
      policy_block: true, // task-level policy block
      flexible: false,
    },
    {
      id: 'evacuate_high_rise_block_a_1',
      category: 'evac_zone',
      demand: 3,
      deadline: 90,
      flexible: false,
    },
  ];

  it('non-agentic (OFF) results in expected blocks/unassigned due to capacity/policy', () => {
    const steps = buildAssignmentSteps(actorsBase, tasks, { cfg: simCfg as any, agenticMode: false, nowSec });

    // Power task: utility crews at capacity -> expect no assignment
    const powerAssigns = assignsFor('restore_hospital_power_1', steps);
    expect(powerAssigns.length).toBe(0);
    const powerBlocked = stepsOf('blocked', steps).some((b) => b.taskId === 'restore_hospital_power_1');
    expect(powerBlocked).toBe(true);

    // Hazmat task: policy block filters all -> expect unassigned/blocked
    const hazAssigns = assignsFor('contain_hazmat_substation_1', steps);
    expect(hazAssigns.length).toBe(0);
    const hazUnassigned = steps.some((s) => (s.type === 'unassigned' || s.type === 'blocked') && s.taskId === 'contain_hazmat_substation_1');
    expect(hazUnassigned).toBe(true);

    // Evac task: evac team near capacity, generalist not eligible in default path -> partial assignment + unmet remainder
    const evacAssigns = assignsFor('evacuate_high_rise_block_a_1', steps);
    expect(evacAssigns.length).toBeGreaterThan(0);
    const evacAssignedOnlyEvacTeam = evacAssigns.every((a) => a.actorId === 'evac_team');
    expect(evacAssignedOnlyEvacTeam).toBe(true);
    const evacBlockedRemainder = stepsOf('blocked', steps).some(
      (b) => b.taskId === 'evacuate_high_rise_block_a_1' && String(b.message || '').toLowerCase().includes('unmet demand')
    );
    expect(evacBlockedRemainder).toBe(true);
  });

  it('agentic (ON) uses generalist override to progress tasks with clear reasoning logs', () => {
    const steps = buildAssignmentSteps(actorsBase, tasks, { cfg: simCfg as any, agenticMode: true, nowSec });

    // Power task: no eligible defaults -> agentic override assigns to generalist
    const powerAssigns = assignsFor('restore_hospital_power_1', steps);
    expect(powerAssigns.length).toBeGreaterThan(0);
    const powerAssignedToGeneralist = powerAssigns.some((a) => a.actorId === 'generalist');
    expect(powerAssignedToGeneralist).toBe(true);
    const powerReasoning = steps.filter((s) => s.taskId === 'restore_hospital_power_1' && (s.type === 'agentThink' || s.type === 'agentAction' || s.type === 'agentInsight'));
    expect(powerReasoning.length).toBeGreaterThan(0);

    // Hazmat task: may remain blocked if higher-priority tasks consume override capacity or are marked busy
    // Ensure we at least attempted reasoning or reported a clear block
    const hazHasReasonOrBlock = steps.some((s) => s.taskId === 'contain_hazmat_substation_1' && (
      s.type === 'agentThink' || s.type === 'agentAction' || s.type === 'agentInsight' || s.type === 'blocked' || s.type === 'unassigned'
    ));
    expect(hazHasReasonOrBlock).toBe(true);

    // Evac task: default best near capacity -> agent may consider overrides or still proceed with clear reasoning
    const evacReasoning = steps.filter((s) => s.taskId === 'evacuate_high_rise_block_a_1' && (s.type === 'agentThink' || s.type === 'agentAction' || s.type === 'agentInsight'));
    expect(evacReasoning.length).toBeGreaterThan(0);
  });
});
