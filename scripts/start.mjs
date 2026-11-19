// Launches the project-local n8n CLI with the environment this demo needs.
// Works from PowerShell with no bash syntax: `node scripts/start.mjs <n8n command> [args]`.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const n8nBin = resolve(projectRoot, 'node_modules', 'n8n', 'bin', 'n8n');

if (!existsSync(n8nBin)) {
  console.error('n8n is not installed. Run "npm install" first.');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) args.push('start');

const child = spawn(process.execPath, [n8nBin, ...args], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    // Keep every n8n file (database, settings, encryption key) inside this project.
    N8N_USER_FOLDER: resolve(projectRoot, '.n8n-data'),
    N8N_PORT: '5678',
    N8N_DIAGNOSTICS_ENABLED: 'false',
  },
});

child.on('error', (error) => {
  console.error(`Could not start n8n: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
