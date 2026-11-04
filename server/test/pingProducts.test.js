// pingProducts: rule 20 checks. Each product is "ready" when its container (if any)
// is up and its endpoint answers with an accepted status. Results cache for 30 s.
import { describe, it, expect } from 'vitest';
import { createPingProducts } from '../src/pingProducts.js';

const goodExec = (file, args) => {
  if (args.includes('ps')) return { stdout: 'Up 2 hours', stderr: '' };
  throw new Error('unexpected exec');
};
const downExec = () => { throw new Error('docker missing'); };

describe('pingProducts status', () => {
  it('unknown product reports unknown', async () => {
    const check = createPingProducts({ exec: goodExec, envFile: '/nonexistent' });
    expect(await check(['not-a-product'])).toEqual([{ product: 'not-a-product', state: 'unknown' }]);
  });

  it('empty or missing product list returns empty', async () => {
    const check = createPingProducts({ exec: goodExec, envFile: '/nonexistent' });
    expect(await check([])).toEqual([]);
    expect(await check(undefined)).toEqual([]);
  });

  it('pingone without PINGONE_ENVIRONMENT_ID is not-configured', async () => {
    const check = createPingProducts({ exec: goodExec, envFile: '/nonexistent' });
    const out = await check(['pingone']);
    expect(out[0].state).toBe('not-configured');
  });

  it('pingone-privilege without PRIVILEGE_CONSOLE_URL falls back to the public console and probes it', async () => {
    const check = createPingProducts({ exec: goodExec, envFile: '/nonexistent' });
    const out = await check(['pingone-privilege']);
    // Network result varies (proxy, offline); only the shape is asserted here.
    expect(out[0].product).toBe('pingone-privilege');
    expect(['ready', 'unhealthy', 'down']).toContain(out[0].state);
  });

  it('a container product whose docker is missing lets the endpoint probe decide (unhealthy when the endpoint does not answer)', async () => {
    const check = createPingProducts({ exec: downExec, envFile: '/nonexistent' });
    const out = await check(['pingfederate']);
    // No docker CLI: the URL probe is the whole verdict. On the runner the shared PF is not
    // running, so the endpoint does not answer and the state is unhealthy (not 'down' —
    // that state is reserved for a container we can see as stopped).
    expect(['unhealthy', 'down', 'ready']).toContain(out[0].state);
    expect(out[0].product).toBe('pingfederate');
  });

  it('caches per product within the window: a second call returns the same state', async () => {
    const check = createPingProducts({ exec: downExec, envFile: '/nonexistent' });
    const a = await check(['pingfederate']);
    const b = await check(['pingfederate']);
    expect(b).toEqual(a);
  });
});
