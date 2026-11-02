import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (f) => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

// The container form is pinned: publish on loopback only, no Docker access, non-root, read-only.
describe('the Docker form of the shelf', () => {
  const compose = read('docker-compose.yml');
  const docker = read('Dockerfile');
  it('publishes on 127.0.0.1 only', () => {
    const ports = [...compose.matchAll(/ports:\s*\[(.*)\]/g)].flatMap((m) => m[1].split(',').map((p) => p.trim().replace(/^"|"$/g, '')));
    expect(ports.length).toBeGreaterThan(0);
    for (const p of ports) expect(p, p).toMatch(/^127\.0\.0\.1:/);
  });
  it('has no Docker socket, no privileged mode, no host network and no demo-folder mount', () => {
    expect(compose).not.toMatch(/docker\.sock/);
    expect(compose).not.toMatch(/privileged|network_mode|pid:\s*host|user:\s*(root|"?0)/);
    const volumes = [...compose.matchAll(/volumes:\s*\[(.*)\]/g)].flatMap((m) => m[1].split(',').map((v) => v.trim().replace(/^"|"$/g, '')));
    expect(volumes).toEqual(['./.data:/data:ro']);
  });
  it('is read-only with every capability dropped and no new privileges', () => {
    expect(compose).toMatch(/read_only:\s*true/);
    expect(compose).toMatch(/cap_drop:\s*\[ALL\]/);
    expect(compose).toMatch(/no-new-privileges:true/);
  });
  it('runs the image as the non-root node user, on Node 26', () => {
    expect(docker).toMatch(/^USER node$/m);
    expect(docker).toMatch(/^FROM node:26-alpine/m);
  });
  it('runs a real init so docker stop is quick, and keeps /tmp as the only writable path', () => {
    expect(compose).toMatch(/init:\s*true/);
    expect(compose).toMatch(/tmpfs:\s*\["\/tmp"\]/);
  });
  it('sets container mode in the image and passes the agent port and allowed hosts through from the host', () => {
    expect(docker).toMatch(/SHELF_IN_DOCKER=1/);
    expect(docker).toMatch(/SHELF_BIND=0\.0\.0\.0/);
    expect(compose).toMatch(/SHELF_AGENT_URL:\s*http:\/\/host\.docker\.internal:\$\{SHELF_AGENT_PORT:-4405\}/);
    expect(compose).toMatch(/SHELF_ALLOWED_HOSTS:/);
  });
  it('gets its agent token and demo root from npm run docker, never from a committed value', () => {
    expect(compose).toMatch(/SHELF_AGENT_TOKEN:\s*\$\{SHELF_AGENT_TOKEN:\?/);
    expect(compose).toMatch(/SHELF_DEMO_ROOT:\s*\$\{SHELF_DEMO_ROOT:\?/);
    expect(docker).not.toMatch(/SHELF_AGENT_TOKEN/);
  });
});
