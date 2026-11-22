import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPlayerSession, savePlayerSession } from '../game-client';
import {
  clearEscapeRecord,
  type EscapeRecord,
  loadEscapeRecord,
  saveEscapeRecord,
} from './escape-record';

const record: EscapeRecord = {
  pin: '482913',
  gameId: '0123456789abcdef0123456789abcdef',
  playerId: 'p1',
  sessionToken: 'tok',
  teamId: 't1',
};

describe('escape record', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('round trips', () => {
    saveEscapeRecord(record);
    expect(loadEscapeRecord('482913')).toEqual(record);
    clearEscapeRecord();
    expect(loadEscapeRecord('482913')).toBeNull();
  });

  it('gives null for another PIN', () => {
    saveEscapeRecord(record);
    expect(loadEscapeRecord('111111')).toBeNull();
  });

  it('gives null when storage throws, and a save does not throw', () => {
    saveEscapeRecord(record);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('private mode');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('private mode');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('private mode');
    });
    expect(loadEscapeRecord('482913')).toBeNull();
    expect(() => saveEscapeRecord(record)).not.toThrow();
    expect(() => clearEscapeRecord()).not.toThrow();
  });

  it('outlives the player session being cleared (a refused reconnect)', () => {
    savePlayerSession({ pin: '482913', sessionToken: 'tok', playerId: 'p1', nickname: 'Ana' });
    saveEscapeRecord(record);
    clearPlayerSession();
    expect(loadEscapeRecord('482913')).toEqual(record);
  });
});
