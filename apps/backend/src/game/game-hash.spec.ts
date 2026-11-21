import { deserializeGame, deserializeRoom, roomHash } from './game-hash';

describe('a room as Redis keeps it', () => {
  const env = process.env;
  afterEach(() => {
    process.env = env;
  });
  const raw = { roomId: 'r', hostUserId: 'h', gameId: 'g', openedAt: '1' };

  it('keeps whether its screens move between steps', () => {
    expect(deserializeRoom({ ...raw, ...roomHash({ motion: false }) }).motion).toBe(false);
    expect(deserializeRoom({ ...raw, ...roomHash({ motion: true }) }).motion).toBe(true);
  });

  it('a room opened before the setting existed follows the instance (LIVE_MOTION)', () => {
    process.env = { ...env, LIVE_MOTION: 'off' };
    expect(deserializeRoom(raw).motion).toBe(false);
    process.env = { ...env };
    delete process.env.LIVE_MOTION;
    expect(deserializeRoom(raw).motion).toBe(true);
  });
});

describe('a game as Redis keeps it', () => {
  const raw = { quizId: '', state: 'LOBBY', currentIndex: '-1', totalQuestions: '0' };

  it('knows an escape game by its kind; a quiz has no kind at all', () => {
    expect(deserializeGame({ ...raw, kind: 'escape' }).kind).toBe('escape');
    expect('kind' in deserializeGame(raw)).toBe(false);
    expect('kind' in deserializeGame({ ...raw, kind: 'other' })).toBe(false);
  });
});
