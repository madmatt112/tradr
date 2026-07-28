// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { type FormStringState, formToWireInput } from './formToWireInput';

// Baseline valid form state. Individual tests override the field(s) under test.
const validForm: FormStringState = {
  S: '150',
  K: '155',
  T: '0.0822',
  sigma: '0.30',
  r: '0.0440',
  q: '0.00',
  type: 'call',
};

describe('formToWireInput', () => {
  it('returns ok with wire input when all fields are valid', () => {
    const result = formToWireInput(validForm);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        S: 150,
        K: 155,
        T: 0.0822,
        sigma: 0.3,
        r: 0.044,
        q: 0,
        type: 'call',
      });
    }
  });

  it("flags S = '' as Required", () => {
    const result = formToWireInput({ ...validForm, S: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors.S).toBe('Required');
    }
  });

  it("flags S = '  ' as Required (trim-aware)", () => {
    const result = formToWireInput({ ...validForm, S: '  ' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors.S).toBe('Required');
    }
  });

  it("flags S = '1e9999' as Must be a finite number", () => {
    const result = formToWireInput({ ...validForm, S: '1e9999' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors.S).toBe('Must be a finite number');
    }
  });

  it("flags S = '1,5' with decimal-separator message", () => {
    const result = formToWireInput({ ...validForm, S: '1,5' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors.S).toBe("Use '.' as decimal separator (e.g. 0.30)");
    }
  });

  it("treats q = '' as omitted so wire .default(0) fires", () => {
    const result = formToWireInput({ ...validForm, q: '' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.q).toBe(0);
    }
  });

  it("propagates wire .positive() rejection for S = '-5'", () => {
    const result = formToWireInput({ ...validForm, S: '-5' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors.S).toBeDefined();
      expect(typeof result.fieldErrors.S).toBe('string');
    }
  });
});
