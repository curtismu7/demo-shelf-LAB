import { describe, expect, it } from 'vitest';
import { resolveAllowStart, resolveBind } from '../src/index.js';

describe('Start/Stop gate (SHELF_ALLOW_START and SHELF_BIND)', () => {
  const gate = (env) => resolveAllowStart(env, resolveBind(env));
  it('is on by default on loopback and off with SHELF_ALLOW_START=0', () => {
    expect(gate({})).toEqual({ allowStart: true, refused: false });
    expect(gate({ SHELF_ALLOW_START: '0' })).toEqual({ allowStart: false, refused: false });
  });
  it('is off without a warning on a non-loopback bind when nobody asked for it', () => {
    expect(gate({ SHELF_BIND: '0.0.0.0' })).toEqual({ allowStart: false, refused: false });
  });
  it('is on when asked for on loopback', () => {
    expect(gate({ SHELF_ALLOW_START: '1' })).toEqual({ allowStart: true, refused: false });
    expect(gate({ SHELF_ALLOW_START: '1', SHELF_BIND: '::1' })).toEqual({ allowStart: true, refused: false });
  });
  it('is refused on a non-loopback bind even with the opt-in', () => {
    expect(gate({ SHELF_ALLOW_START: '1', SHELF_BIND: '0.0.0.0' })).toEqual({ allowStart: false, refused: true });
    expect(gate({ SHELF_ALLOW_START: '1', SHELF_BIND: '192.168.1.5' })).toEqual({ allowStart: false, refused: true });
  });
});
