// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { EVENT_NAMES } from './events.types';

describe('events.types EVENT_NAMES', () => {
  it('every value matches the {feature}:{action} naming convention (Req 7.4)', () => {
    const pattern = /^[a-z]+(-[a-z]+)*:[a-z]+(-[a-z]+)*$/;
    for (const name of EVENT_NAMES) {
      expect(name).toMatch(pattern);
    }
  });
});
