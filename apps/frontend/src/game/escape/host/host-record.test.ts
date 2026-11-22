import { afterEach, describe, expect, it, vi } from 'vitest';
import { RECORD_TTL_MS, loadEscapeRecord, saveEscapeRecord } from '../escape-record';
import { clearHostRecord, loadHostRecord, saveHostRecord } from './host-record';

const record = { pin: '482913', gameId: '0123456789abcdef0123456789abcdef' };

describe('host record', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('round trips under its own key', () => {
    saveHostRecord(record);
    expect(loadHostRecord('482913')).toMatchObject(record);
    expect(localStorage.getItem('live.escape.host.last')).not.toBeNull();
    clearHostRecord();
    expect(loadHostRecord('482913')).toBeNull();
  });

  it('gives null for another PIN', () => {
    saveHostRecord(record);
    expect(loadHostRecord('111111')).toBeNull();
  });

  it("is not the phone's record, nor the other way round", () => {
    saveHostRecord(record);
    expect(loadEscapeRecord('482913')).toBeNull();
    saveEscapeRecord({ ...record, playerId: 'p1', sessionToken: 'tok', teamId: null });
    clearHostRecord();
    expect(loadEscapeRecord('482913')).not.toBeNull();
  });

  it('gives null once too old', () => {
    vi.useFakeTimers();
    saveHostRecord(record);
    vi.advanceTimersByTime(RECORD_TTL_MS + 1);
    expect(loadHostRecord('482913')).toBeNull();
  });

  it('a throwing storage throws nothing', () => {
    for (const m of ['getItem', 'setItem', 'removeItem'] as const) {
      vi.spyOn(Storage.prototype, m).mockImplementation(() => {
        throw new Error('private mode');
      });
    }
    expect(() => saveHostRecord(record)).not.toThrow();
    expect(loadHostRecord('482913')).toBeNull();
    expect(() => clearHostRecord()).not.toThrow();
  });
});
