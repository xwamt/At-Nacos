import { describe, expect, it } from 'vitest';
import { formatTimestamp } from '../../src/utils/time';

describe('formatTimestamp', () => {
  /**
   * Padded, always. A column of timestamps is read by scanning down it, and
   * `2026-1-2 3:04:05` in the middle of ten padded rows breaks that.
   */
  it.each([
    ['a single-digit month, day and hour', Date.parse('2026-01-02T03:04:05Z')],
    ['a two-digit everything', Date.parse('2026-11-23T14:35:46Z')],
    ['the epoch itself', 0]
  ])('writes %s as a fixed-width local timestamp', (_case, epochMillis) => {
    expect(formatTimestamp(epochMillis)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  /**
   * Local rather than UTC, which is the whole choice this function makes: the
   * moment is compared against a deployment log or a colleague's memory, and
   * both of those are in the reader's zone. Asserted by reading it back --
   * V8 parses this shape as local time -- because the expectation cannot be
   * written down without knowing which zone the test is running in.
   */
  it('renders the moment it was given, read back in the same zone', () => {
    const epochMillis = Date.parse('2026-08-14T02:03:04.000Z');

    expect(new Date(formatTimestamp(epochMillis)).getTime()).toBe(epochMillis);
  });

  it('drops the sub-second part rather than rounding into the next second', () => {
    const second = Date.parse('2026-08-14T02:03:04.000Z');

    expect(formatTimestamp(second + 999)).toBe(formatTimestamp(second));
  });

  it('gives two different moments two different renderings', () => {
    const first = Date.parse('2026-08-14T02:03:04Z');

    expect(formatTimestamp(first)).not.toBe(formatTimestamp(first + 1000));
  });
});
