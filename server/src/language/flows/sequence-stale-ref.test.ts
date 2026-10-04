import { describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  DriftReason,
  FlowStepTool,
  ReticleCommand,
  type CommandResult,
  type FlowStep,
  type FlowStepResult,
} from '@reticlehq/core';
import { runSequenceStep } from './flow-step-runners.js';
import type { FlowReplaySession } from './flow-replay.js';

/**
 * A re-render between locating an element and acting on it must not lose a saved sequence.
 *
 * A saved `act_sequence` resolved every sub-step's anchor up front and sent one batch. On a framework
 * that re-renders after the first action, the refs for the rest are already dead when the batch
 * reaches them: the page throws `ref 'e..' no longer resolves to an element`, the step fails with
 * that raw sentence, and nothing says which sub-steps had already run. The same anchor is still on
 * the page under a new ref, which is why replaying the flow by hand worked.
 *
 * The page below ties every ref to a render generation. An action named in `rerenderAfter` bumps the
 * generation once it has run, which kills every ref handed out before it.
 */

interface PageOptions {
  /** Sub-step testids whose action re-renders the page once it has run. */
  readonly rerenderAfter?: readonly string[];
  /** Bump the generation on EVERY lookup, so no ref ever lives long enough to be used. */
  readonly alwaysStale?: boolean;
  /** Fail this testid's action for a reason that is not staleness. */
  readonly failFor?: string;
  /** Once the page has re-rendered, this testid is found twice, so which one is meant is no longer clear. */
  readonly doubledAfterRerender?: string;
}

function rerenderingPage(options: PageOptions = {}): {
  session: FlowReplaySession;
  performed: string[];
  batches: () => number;
} {
  let generation = 0;
  let batches = 0;
  const performed: string[] = [];
  const testidOf = (ref: string): string => ref.split(':')[1] ?? '';
  const session: FlowReplaySession = {
    command: (name: string, args: Record<string, unknown> = {}) => {
      if (ReticleCommand.QUERY === name) {
        const ref = `g${String(generation)}:${String(args['value'])}`;
        if (true === options.alwaysStale) generation += 1;
        const doubled = generation > 0 && args['value'] === options.doubledAfterRerender;
        return Promise.resolve({
          kind: 'command_result',
          id: 'q',
          ok: true,
          result: { elements: doubled ? [{ ref }, { ref: `${ref}-other` }] : [{ ref }] },
        } as unknown as CommandResult);
      }
      if (ReticleCommand.ACT_SEQUENCE === name) {
        batches += 1;
        for (const step of args['steps'] as { ref: string }[]) {
          if (!step.ref.startsWith(`g${String(generation)}:`)) {
            return Promise.resolve({
              kind: 'command_result',
              id: 'a',
              ok: false,
              error: `ref '${step.ref}' no longer resolves to an element`,
            } as CommandResult);
          }
          const testid = testidOf(step.ref);
          if (testid === options.failFor) {
            return Promise.resolve({
              kind: 'command_result',
              id: 'a',
              ok: false,
              error: 'element is disabled',
            } as CommandResult);
          }
          performed.push(testid);
          if (true === options.rerenderAfter?.includes(testid)) generation += 1;
        }
      }
      return Promise.resolve({ kind: 'command_result', id: 'a', ok: true } as CommandResult);
    },
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
  };
  return { session, performed, batches: () => batches };
}

function sub(testid: string, expectTestid?: string): FlowStep {
  return {
    tool: FlowStepTool.ACT,
    anchor: { kind: AnchorKind.TESTID, value: testid },
    action: ActionType.CLICK,
    args: {},
    ...(expectTestid === undefined
      ? {}
      : { expect: { kind: 'element', query: { testid: expectTestid } } }),
  };
}

const parent: FlowStep = {
  tool: FlowStepTool.ACT_SEQUENCE,
  anchor: { kind: AnchorKind.TESTID, value: 'checkout' },
  args: {},
};

const run = (subs: FlowStep[], session: FlowReplaySession): Promise<FlowStepResult> =>
  runSequenceStep(session, parent, 3, subs, false, () => Promise.resolve());

describe('a sequence dispatched as one batch survives a re-render part way through', () => {
  it('re-resolves what is left and finishes, without repeating what already ran', async () => {
    // `fill` re-renders the page, so the refs for `submit` and `close` are dead when they are reached.
    const { session, performed } = rerenderingPage({ rerenderAfter: ['fill'] });
    const result = await run([sub('fill'), sub('submit'), sub('close')], session);
    expect(result.ok).toBe(true);
    // Each action exactly once: a retry that started over would click `fill` twice.
    expect(performed).toEqual(['fill', 'submit', 'close']);
  });

  it('copes with the page re-rendering more than once', async () => {
    const { session, performed } = rerenderingPage({ rerenderAfter: ['fill', 'submit'] });
    const result = await run([sub('fill'), sub('submit'), sub('close')], session);
    expect(result.ok).toBe(true);
    expect(performed).toEqual(['fill', 'submit', 'close']);
  });

  it('does not retry a failure that is not staleness', async () => {
    const { session, performed, batches } = rerenderingPage({ failFor: 'submit' });
    const result = await run([sub('fill'), sub('submit')], session);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('disabled');
    expect(batches()).toBe(1);
    expect(performed).toEqual(['fill']);
  });
});

describe('a re-render that makes the retry unsafe is reported, not guessed through', () => {
  it('does not start again when two sub-steps share an element, because it cannot tell which one failed', async () => {
    // Both sub-steps hold the same ref. The first one runs and re-renders the page, so the second
    // one is the stale one, but the page only names the ref, and the first sub-step has it too.
    // Starting from the first would click it a second time.
    const { session, performed, batches } = rerenderingPage({ rerenderAfter: ['save'] });
    const result = await run([sub('save'), sub('save')], session);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no longer resolves to an element/);
    expect(result.error).toMatch(/could not be told/);
    expect(performed).toEqual(['save']);
    expect(batches()).toBe(1);
  });

  it('reports drift when the re-render made an anchor match several elements', async () => {
    // After `fill`, `submit` is found twice. Taking the first of them would act on an element the
    // recording may not have meant and report success.
    const { session, performed } = rerenderingPage({
      rerenderAfter: ['fill'],
      doubledAfterRerender: 'submit',
    });
    const result = await run([sub('fill'), sub('submit'), sub('close')], session);
    expect(result.ok).toBe(false);
    expect(result.drift?.reasonKind).toBe(DriftReason.ANCHOR_AMBIGUOUS);
    // Nothing was acted on after the ambiguity, and what ran before it ran once.
    expect(performed).toEqual(['fill']);
  });
});

describe('a sequence walked sub-step by sub-step survives a re-render too', () => {
  it('resolves each sub-step just before it acts, not all of them up front', async () => {
    // `fill` declares an expectation, so the sequence is walked. Its refs for the later sub-steps
    // were resolved before `fill` ran and are dead by the time they are used.
    const { session, performed } = rerenderingPage({ rerenderAfter: ['fill'] });
    const result = await run([sub('fill', 'form'), sub('submit'), sub('close')], session);
    expect(result.ok).toBe(true);
    expect(performed).toEqual(['fill', 'submit', 'close']);
  });
});

describe('a target that never holds still long enough is reported, with how far the sequence got', () => {
  it('fails once, naming the sub-step and what had already run', async () => {
    const { session, performed } = rerenderingPage({ alwaysStale: true });
    const result = await run([sub('fill'), sub('submit')], session);
    expect(result.ok).toBe(false);
    // Still a stale-ref error, so the run can tell this apart from an element that is simply gone.
    expect(result.error).toMatch(/no longer resolves to an element/);
    // And it says WHERE: the first sub-step, with nothing before it having run.
    expect(result.error).toMatch(/sub-step 0 of 2/);
    expect(performed).toEqual([]);
  });
});
