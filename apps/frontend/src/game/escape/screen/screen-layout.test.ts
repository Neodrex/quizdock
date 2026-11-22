import { describe, expect, it } from 'vitest';
import { laneScaleOf, RACE_EM, TALL_LANE_EM, TALL_LANES_MAX } from './screen-layout';

describe('laneScaleOf', () => {
  it('scales a small race up, within the race height', () => {
    for (let n = 1; n <= TALL_LANES_MAX; n++) {
      const s = laneScaleOf(n);
      expect(s).toBeGreaterThan(1);
      expect(s * TALL_LANE_EM * n + 0.5 * (n - 1)).toBeLessThanOrEqual(RACE_EM);
    }
  });

  it('leaves larger races as they are', () => {
    expect(laneScaleOf(TALL_LANES_MAX + 1)).toBe(1);
    expect(laneScaleOf(30)).toBe(1);
  });
});
