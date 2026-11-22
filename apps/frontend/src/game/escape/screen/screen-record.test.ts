import { afterEach, describe, expect, it, vi } from 'vitest';
import { screenFinaleOf } from './screen-fixtures';
import { loadScreenRecord, markScreenReplayed, saveScreenRecord } from './screen-record';

describe('screen record', () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('round-trips per PIN in sessionStorage', () => {
    const finale = screenFinaleOf();
    saveScreenRecord('482913', { gameId: finale.gameId, replayed: false, finale });
    expect(sessionStorage.getItem('live.escape.screen.482913')).not.toBeNull();
    expect(loadScreenRecord('482913')).toEqual({
      pin: '482913',
      gameId: finale.gameId,
      replayed: false,
      finale,
    });
  });

  it('gives null for another PIN', () => {
    const finale = screenFinaleOf();
    saveScreenRecord('482913', { gameId: finale.gameId, replayed: false, finale });
    expect(loadScreenRecord('111111')).toBeNull();
  });

  it('marks the run replayed, only for its own run', () => {
    const finale = screenFinaleOf();
    saveScreenRecord('482913', { gameId: finale.gameId, replayed: false, finale });
    markScreenReplayed('482913', 'another-run');
    expect(loadScreenRecord('482913')?.replayed).toBe(false);
    markScreenReplayed('482913', finale.gameId);
    expect(loadScreenRecord('482913')?.replayed).toBe(true);
  });

  it('never throws when the storage does', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const finale = screenFinaleOf();
    expect(() =>
      saveScreenRecord('482913', { gameId: finale.gameId, replayed: false, finale }),
    ).not.toThrow();
    expect(() => markScreenReplayed('482913', finale.gameId)).not.toThrow();
    expect(loadScreenRecord('482913')).toBeNull();
  });

  it('ignores a record that is not one', () => {
    sessionStorage.setItem('live.escape.screen.482913', '{"pin":"482913"}');
    expect(loadScreenRecord('482913')).toBeNull();
    sessionStorage.setItem('live.escape.screen.482913', 'not json');
    expect(loadScreenRecord('482913')).toBeNull();
  });
});
