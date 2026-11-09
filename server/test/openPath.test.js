import { describe, expect, it } from 'vitest';
import { openUrl, startScript, expandWhere } from '../src/app.js';
import { validateDemos } from '../src/registry.js';

const base = { id: 'env-map-test', name: 'X', description: 'd', url: 'http://localhost:7805' };

describe('openPath', () => {
  it('appends openPath to the origin for Open, keeps url alone without it', () => {
    expect(openUrl({ ...base, openPath: '/#/diagram' })).toBe('http://localhost:7805/#/diagram');
    expect(openUrl(base)).toBe('http://localhost:7805');
  });
  it('start script opens the deep link but health-checks the origin', () => {
    const s = startScript({ ...base, composeFile: '/tmp/a/docker-compose.yml', openPath: '/#/diagram' });
    expect(s).toContain("open 'http://localhost:7805/#/diagram'");
    expect(s).toContain('curl -sfso /dev/null http://localhost:7805/api/health');
  });
  it('validates openPath and keeps it', () => {
    expect(validateDemos([{ ...base, openPath: '/#/diagram' }])[0].openPath).toBe('/#/diagram');
    for (const bad of ['#/diagram', '//evil.com', '/../x', '/a b', 5]) {
      expect(() => validateDemos([{ ...base, openPath: bad }])).toThrow(/openPath/);
    }
  });
  it('mock card does not inherit openPath', () => {
    const cards = expandWhere([{ ...base, openPath: '/#/diagram', where: 'both', mockUrl: 'http://localhost:9999' }]);
    expect(cards.find((c) => c.where === 'mock').openPath).toBeUndefined();
  });
});
