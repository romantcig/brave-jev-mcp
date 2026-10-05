import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyMinimumValues,
  logRaisedToStderr,
  MINIMUM_VALUES,
  withAdjustments,
  type FilteredResponse,
} from './index.js';

describe('MINIMUM_VALUES', () => {
  it('carries exactly the four numeric tool parameters with Brave-documented floors', () => {
    assert.deepEqual(Object.keys(MINIMUM_VALUES).sort(), [
      'count',
      'maximum_number_of_tokens',
      'maximum_number_of_tokens_per_url',
      'maximum_number_of_urls',
    ]);
    assert.deepEqual(
      { ...MINIMUM_VALUES },
      {
        count: 1,
        maximum_number_of_urls: 1,
        maximum_number_of_tokens: 1024,
        maximum_number_of_tokens_per_url: 512,
      }
    );
  });
});

describe('applyMinimumValues', () => {
  it('raises below-minimum values and reports each adjustment', () => {
    const { adjusted, raised } = applyMinimumValues({
      count: 0,
      maximum_number_of_urls: -1,
      maximum_number_of_tokens: 100,
      maximum_number_of_tokens_per_url: 500,
    });

    assert.deepEqual(adjusted, {
      count: 1,
      maximum_number_of_urls: 1,
      maximum_number_of_tokens: 1024,
      maximum_number_of_tokens_per_url: 512,
    });
    assert.deepEqual(raised, [
      { parameter: 'count', requested: 0, applied: 1 },
      { parameter: 'maximum_number_of_urls', requested: -1, applied: 1 },
      { parameter: 'maximum_number_of_tokens', requested: 100, applied: 1024 },
      { parameter: 'maximum_number_of_tokens_per_url', requested: 500, applied: 512 },
    ]);
  });

  it('keeps values at or above the minimum and preserves unknown keys', () => {
    const params = { count: 10, maximum_number_of_tokens_per_url: 512, query: 'brave browser' };

    const { adjusted, raised } = applyMinimumValues(params);

    assert.deepEqual(adjusted, params);
    assert.notEqual(adjusted, params);
    assert.deepEqual(raised, []);
  });
});

describe('withAdjustments', () => {
  const payload: FilteredResponse = {
    grounding: { generic: [], map: [] },
    sources: {},
  };

  it('returns the payload unchanged when nothing was raised', () => {
    assert.deepEqual(withAdjustments(payload, []), payload);
  });

  it('attaches the adjustment list copy-on-write', () => {
    const raised = [
      { parameter: 'count', requested: 0, applied: 1 },
      { parameter: 'maximum_number_of_tokens', requested: 100, applied: 1024 },
    ];

    const result = withAdjustments(payload, raised);

    assert.notEqual(result, payload);
    assert.deepEqual(result.parameter_adjustments, {
      count: { requested: 0, applied: 1 },
      maximum_number_of_tokens: { requested: 100, applied: 1024 },
    });
    assert.equal('parameter_adjustments' in payload, false);
  });
});

describe('logRaisedToStderr', () => {
  it('stays silent when nothing was raised', () => {
    const lines: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args);
    };
    try {
      logRaisedToStderr([]);
      assert.equal(lines.length, 0);
    } finally {
      console.error = original;
    }
  });

  it('writes one diagnostic line to stderr when clamping happened', () => {
    const lines: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args);
    };
    try {
      logRaisedToStderr([{ parameter: 'count', requested: 0, applied: 1 }]);
      assert.equal(lines.length, 1);
      assert.match(String(lines[0]?.[0]), /count 0 -> 1/);
    } finally {
      console.error = original;
    }
  });
});
