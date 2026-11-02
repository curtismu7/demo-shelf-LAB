import { describe, expect, it } from 'vitest';
import { resolveAllowStart, resolveBind } from '../src/index.js';

describe('Start/Stop gate (SHELF_BIND and SHELF_IN_DOCKER)', () => {
  const gate = (env) => resolveAllowStart(env, resolveBind(env));
  it('is always on host-run on loopback, with no off switch', () => {
    expect(gate({})).toEqual({ allowStart: true, refused: false, inDocker: false });
    expect(gate({ SHELF_BIND: '::1' })).toEqual({ allowStart: true, refused: false, inDocker: false });
    expect(gate({ SHELF_ALLOW_START: '0' })).toEqual({ allowStart: true, refused: false, inDocker: false });
  });
  it('is refused host-run on a non-loopback bind', () => {
    expect(gate({ SHELF_BIND: '0.0.0.0' })).toEqual({ allowStart: false, refused: true, inDocker: false });
    expect(gate({ SHELF_BIND: '192.168.1.5' })).toEqual({ allowStart: false, refused: true, inDocker: false });
  });
  it('is on in the container, which binds 0.0.0.0 inside and hands the work to the start agent', () => {
    expect(gate({ SHELF_IN_DOCKER: '1', SHELF_BIND: '0.0.0.0' })).toEqual({ allowStart: true, refused: false, inDocker: true });
  });
});
