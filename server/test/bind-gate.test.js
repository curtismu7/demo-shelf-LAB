import { describe, expect, it } from 'vitest';
import { resolveAllowStart, resolveBind } from '../src/index.js';

describe('Start/Stop gate (SHELF_ALLOW_START and SHELF_BIND)', () => {
  const gate = (env) => resolveAllowStart(env, resolveBind(env));
  it('is off without the opt-in', () => {
    expect(gate({})).toEqual({ allowStart: false, refused: false });
    expect(gate({ SHELF_ALLOW_START: '0' })).toEqual({ allowStart: false, refused: false });
  });
  it('is on with the opt-in on loopback', () => {
    expect(gate({ SHELF_ALLOW_START: '1' })).toEqual({ allowStart: true, refused: false });
    expect(gate({ SHELF_ALLOW_START: '1', SHELF_BIND: '::1' })).toEqual({ allowStart: true, refused: false });
  });
  it('is refused on a non-loopback bind even with the opt-in', () => {
    expect(gate({ SHELF_ALLOW_START: '1', SHELF_BIND: '0.0.0.0' })).toEqual({ allowStart: false, refused: true });
    expect(gate({ SHELF_ALLOW_START: '1', SHELF_BIND: '192.168.1.5' })).toEqual({ allowStart: false, refused: true });
  });
});
