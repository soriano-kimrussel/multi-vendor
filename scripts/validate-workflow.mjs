// Static checks on workflows/multi-vendor-product-feed.json. No n8n needed.
//   node scripts/validate-workflow.mjs
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(root, 'workflows', 'multi-vendor-product-feed.json');

// Nodes that need a network or credentials. Exactly these must be disabled.
const EXPECTED_DISABLED = [
  'Schedule Trigger',
  'HTTP: Supplier A (JSON)',
  'HTTP: Supplier B (CSV)',
  'HTTP: Supplier C (XML)',
  'Notify feed errors',
  'Append to Errors tab',
  'Upsert products',
  'Update product feed tab',
  'Feed run summary',
];

const errors = [];
const fail = (message) => errors.push(message);

let workflow;
try {
  workflow = JSON.parse(readFileSync(workflowPath, 'utf8'));
} catch (error) {
  console.error(`FAIL  cannot read or parse ${workflowPath}: ${error.message}`);
  process.exit(1);
}

const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
if (nodes.length === 0) fail('workflow has no nodes');

// 1. No duplicated node names (or ids).
const names = new Set();
const ids = new Set();
for (const node of nodes) {
  if (!node.name) fail(`node without a name (id ${node.id})`);
  if (names.has(node.name)) fail(`duplicate node name: "${node.name}"`);
  names.add(node.name);
  if (ids.has(node.id)) fail(`duplicate node id: ${node.id} ("${node.name}")`);
  ids.add(node.id);
}

// 2. Every connection starts and ends at an existing node.
let connectionCount = 0;
for (const [source, byType] of Object.entries(workflow.connections ?? {})) {
  if (!names.has(source)) fail(`connection from unknown node: "${source}"`);
  for (const outputs of Object.values(byType)) {
    for (const targets of outputs) {
      for (const target of targets ?? []) {
        connectionCount += 1;
        if (!names.has(target.node)) fail(`connection "${source}" -> unknown node "${target.node}"`);
      }
    }
  }
}

// 3. The disabled nodes are exactly the expected ones.
const disabled = nodes.filter((node) => node.disabled === true).map((node) => node.name);
for (const name of EXPECTED_DISABLED) {
  if (!names.has(name)) fail(`expected node is missing: "${name}"`);
  else if (!disabled.includes(name)) fail(`node should be disabled but is enabled: "${name}"`);
}
for (const name of disabled) {
  if (!EXPECTED_DISABLED.includes(name)) fail(`node is disabled but should be enabled: "${name}"`);
}

// 4. Pinned data refers to existing nodes.
for (const name of Object.keys(workflow.pinData ?? {})) {
  if (!names.has(name)) fail(`pinned data for unknown node: "${name}"`);
}

// 5. Every Code node body is syntactically valid JavaScript.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const codeNodes = nodes.filter((node) => node.type === 'n8n-nodes-base.code');
for (const node of codeNodes) {
  try {
    new AsyncFunction('$input', '$', '$json', node.parameters?.jsCode ?? '');
  } catch (error) {
    fail(`syntax error in Code node "${node.name}": ${error.message}`);
  }
}

// 6. The pinned sample data still matches the files in samples/.
const readSample = (file) => readFileSync(resolve(root, 'samples', file), 'utf8').replace(/\r\n/g, '\n');
const pinned = (name) => workflow.pinData?.[name]?.[0]?.json;
const sampleChecks = [
  ['Sample: Supplier A', 'supplier-a.json', (json) => JSON.stringify(json), (text) => JSON.stringify(JSON.parse(text))],
  ['Sample: Supplier B', 'supplier-b.csv', (json) => json?.data, (text) => text],
  ['Sample: Supplier C', 'supplier-c.xml', (json) => json?.data, (text) => text],
];
for (const [name, file, fromPin, fromFile] of sampleChecks) {
  try {
    if (fromPin(pinned(name)) !== fromFile(readSample(file))) {
      fail(`pinned data on "${name}" differs from samples/${file} (run "npm run build:workflow")`);
    }
  } catch (error) {
    fail(`cannot compare "${name}" with samples/${file}: ${error.message}`);
  }
}

if (errors.length > 0) {
  for (const message of errors) console.error(`FAIL  ${message}`);
  console.error(`\n${errors.length} problem(s) found in ${workflowPath}`);
  process.exit(1);
}

console.log(`OK    ${nodes.length} nodes, unique names and ids`);
console.log(`OK    ${connectionCount} connections, all between existing nodes`);
console.log(`OK    ${disabled.length} disabled nodes, exactly the expected set`);
console.log(`OK    ${codeNodes.length} Code nodes parse as JavaScript`);
console.log('OK    pinned sample data matches samples/');
