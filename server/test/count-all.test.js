import { describe, it, expect } from 'vitest';
import { runningProjects } from '../src/control.js';

const exec = (rows) => async () => ({ stdout: JSON.stringify(rows) });

describe('the running count is every running compose project, not only shelf demos', () => {
  it('counts a running project from any path, skips exited ones and leaves the shelf itself out', async () => {
    const shelfDir = '/Users/x/demo-shelf-LAB';
    const rows = [
      { Name: 'worker-demo', Status: 'running(1)', ConfigFiles: '/Users/x/Development/worker-demo-LAB/docker-compose.yml' },
      { Name: 'stolen-token-lab', Status: 'running(1)', ConfigFiles: '/tmp/fr-stolen-token-LAB/docker-compose.yml' },
      { Name: 'old-lab', Status: 'exited(0)', ConfigFiles: '/Users/x/old/docker-compose.yml' },
      { Name: 'demo-shelf-lab', Status: 'running(1)', ConfigFiles: shelfDir + '/docker-compose.yml' },
    ];
    const list = await runningProjects(exec(rows), shelfDir);
    expect(list.map((p) => p.name)).toEqual(['worker-demo', 'stolen-token-lab']);
  });

  it('is unknown (null) when docker cannot answer, never zero', async () => {
    const broken = async () => { throw new Error('no docker'); };
    expect(await runningProjects(broken, '/x')).toBeNull();
  });
});
