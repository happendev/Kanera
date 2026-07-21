import { execFileSync } from 'node:child_process';

const devPorts = [3000, 3003, 4200];
const pids = new Set();

for (const port of devPorts) {
  try {
    const output = execFileSync(
      'lsof',
      ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );

    for (const pid of output.trim().split(/\s+/).filter(Boolean)) {
      pids.add(Number(pid));
    }
  } catch (error) {
    // lsof exits with status 1 when no process is listening on the port.
    if (error.status !== 1) {
      throw error;
    }
  }
}

for (const pid of pids) {
  process.kill(pid, 'SIGKILL');
}

if (pids.size > 0) {
  console.log(`Cleared dev ports ${devPorts.join(', ')} (killed PIDs: ${[...pids].join(', ')}).`);
}
