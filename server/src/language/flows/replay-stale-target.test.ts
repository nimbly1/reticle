import { describe, expect, it } from 'vitest';
import { DriftReason, ReplayStatus, type FlowStepResult } from '@reticlehq/core';
import { staleTargetResult } from './flow-step-runners.js';

/**
 * A step whose target kept going stale is not a failed step, and the run has to say what it is.
 *
 * Replay re-resolves a stale ref and goes on while that gets it further. When a step's element is
 * still stale after that, the page was re-rendering around the step faster than the replay could
 * target it. That was reported as `status: error` with the browser's raw sentence, which reads as
 * "your app broke", sends a reader into product code that is fine, and says nothing about what had
 * already been proved. It is an unverified run: the steps before it are real, and nothing after it
 * ran.
 */

const ok = (step: number): FlowStepResult => ({ step, anchor: `a${String(step)}`, ok: true });
const stale = (step: number): FlowStepResult => ({
  step,
  anchor: `a${String(step)}`,
  ok: false,
  error: "ref 'g3:submit' no longer resolves to an element (sub-step 1 of 2; 1 before it ran)",
});

describe('a step whose target stayed stale', () => {
  it('is unverifiable, and keeps every earlier verdict and the failing step in place', () => {
    const steps = [ok(0), ok(1), stale(2)];
    const result = staleTargetResult('checkout', steps);
    expect(result?.status).toBe(ReplayStatus.UNVERIFIABLE);
    expect(result?.steps).toEqual(steps);
  });

  it('names the step, says nothing after it ran, and does not blame the app', () => {
    const reason = staleTargetResult('checkout', [ok(0), stale(1)])?.unverifiable?.reason ?? '';
    expect(reason).toContain('step 1');
    expect(reason).toMatch(/nothing after it/i);
    expect(reason).toMatch(/re-render/i);
    expect(reason).toMatch(/nothing here says the app failed/i);
  });

  it('does not carry the raw browser sentence as the run-level error', () => {
    const result = staleTargetResult('checkout', [stale(0)]);
    expect(result?.error).toBeUndefined();
  });
});

describe('everything else is left to the ordinary verdict', () => {
  it('a failure that is not staleness is not reclassified', () => {
    const failed: FlowStepResult = {
      step: 1,
      anchor: 'a',
      ok: false,
      error: 'element is disabled',
    };
    expect(staleTargetResult('checkout', [ok(0), failed])).toBeUndefined();
  });

  it('a run with a drifted anchor keeps its drift verdict', () => {
    const drifted: FlowStepResult = {
      step: 1,
      anchor: 'a',
      ok: false,
      drift: {
        reasonKind: DriftReason.TESTID_NOT_FOUND,
        reason: 'testid "x" not found',
        anchor: 'a',
        nearest: null,
      },
    };
    expect(staleTargetResult('checkout', [ok(0), drifted, stale(2)])).toBeUndefined();
  });

  it('a clean run is not touched', () => {
    expect(staleTargetResult('checkout', [ok(0), ok(1)])).toBeUndefined();
  });
});
