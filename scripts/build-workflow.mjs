// Generates workflows/multi-vendor-product-feed.json from the files in samples/.
// The sample feeds are embedded in the "Sample: Supplier X" Code nodes and pinned to them,
// so the workflow runs offline. Re-run `npm run build:workflow` after editing a sample file.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readSample = (name) => readFileSync(resolve(root, 'samples', name), 'utf8').replace(/\r\n/g, '\n');

const sampleA = JSON.parse(readSample('supplier-a.json'));
const sampleB = readSample('supplier-b.csv');
const sampleC = readSample('supplier-c.xml');

const WORKFLOW_ID = 'mvProductFeed001';

function uuid(name) {
  const h = createHash('sha1').update(`multi-vendor-product-feed:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// Code node sources. Plain JS, no template literals, so they embed cleanly.
// ---------------------------------------------------------------------------

const HELPERS = String.raw`function clean(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}
// Money is read from its decimal text and snapped to whole cents once, here.
// Everything downstream does integer-cent math and only divides by 100 at the end.
function toMoney(v) {
  const s = clean(v).replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 100) / 100;
}
function toInt(v) {
  const s = clean(v).replace(/[,\s]/g, '');
  if (!/^-?\d+$/.test(s)) return null;
  return Number(s);
}
function toIso(v) {
  const s = clean(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
`;

const sampleCode = (label, payload) =>
  `// Offline stand-in for the ${label} HTTP Request node.
// useSampleData = true  -> return the embedded copy of the sample feed.
// useSampleData = false -> pass the live HTTP response straight through.
const config = $('Config').first().json;
if (!config.useSampleData) {
  return $input.all();
}
const SAMPLE = ${JSON.stringify(payload, null, 2)};
return [{ json: SAMPLE }];
`;

const normalizeA =
  HELPERS +
  String.raw`
// Supplier A: JSON API. One item whose "products" array holds the rows.
const SUPPLIER = 'Supplier A';
const defaultCurrency = $('Config').first().json.currency;

const rows = [];
for (const item of $input.all()) {
  const products = Array.isArray(item.json.products) ? item.json.products : [];
  for (const product of products) rows.push(product);
}

return rows.map((p, index) => ({
  json: {
    sku: clean(p.sku).toUpperCase(),
    name: clean(p.title),
    brand: clean(p.brand),
    category: clean(p.category),
    cost: toMoney(p.unitCost),
    currency: clean(p.currency).toUpperCase() || defaultCurrency,
    stock: toInt(p.qtyAvailable),
    supplier: SUPPLIER,
    sourceUpdatedAt: toIso(p.updatedAt),
    sourceRow: index + 1,
  },
}));
`;

const normalizeB =
  HELPERS +
  String.raw`
// Supplier B: CSV export. The raw text arrives in the "data" field.
const SUPPLIER = 'Supplier B';
const defaultCurrency = $('Config').first().json.currency;

// Small RFC 4180 parser: quoted fields, embedded commas, doubled quotes, CRLF or LF.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const endRow = () => {
    row.push(field);
    field = '';
    if (row.some((f) => f.trim() !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else {
      field += c;
    }
  }
  endRow();
  return rows;
}

const out = [];
for (const item of $input.all()) {
  const table = parseCsv(String(item.json.data ?? ''));
  if (table.length === 0) continue;
  const header = table[0].map((h) => h.trim());
  const col = (record, name) => record[header.indexOf(name)];
  table.slice(1).forEach((record, index) => {
    out.push({
      json: {
        sku: clean(col(record, 'Item Code')).toUpperCase(),
        name: clean(col(record, 'Description')),
        brand: clean(col(record, 'Manufacturer')),
        category: clean(col(record, 'Dept')),
        cost: toMoney(col(record, 'Wholesale Price')),
        currency: defaultCurrency,
        stock: toInt(col(record, 'Stock On Hand')),
        supplier: SUPPLIER,
        sourceUpdatedAt: toIso(col(record, 'Last Updated')),
        sourceRow: index + 1,
      },
    });
  });
}
return out;
`;

const normalizeC =
  HELPERS +
  String.raw`
// Supplier C: XML feed. The raw text arrives in the "data" field.
const SUPPLIER = 'Supplier C';
const defaultCurrency = $('Config').first().json.currency;

function xmlText(raw) {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  if (cdata) return cdata[1];
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
// Returns the text and attributes of the first <name>...</name> element in a block.
// Self-closing or missing elements come back as empty text.
function element(block, name) {
  const m = new RegExp('<' + name + '\\b([^>]*)>([\\s\\S]*?)</' + name + '>').exec(block);
  return m ? { attrs: m[1], text: xmlText(m[2]) } : { attrs: '', text: '' };
}
function attribute(attrs, name) {
  const m = new RegExp('\\b' + name + '="([^"]*)"').exec(attrs);
  return m ? m[1] : '';
}

const out = [];
for (const item of $input.all()) {
  const xml = String(item.json.data ?? '');
  const blocks = [...xml.matchAll(/<product\b[^>]*>([\s\S]*?)<\/product>/g)].map((m) => m[1]);
  blocks.forEach((block, index) => {
    const price = element(block, 'price');
    out.push({
      json: {
        sku: clean(element(block, 'sku').text).toUpperCase(),
        name: clean(element(block, 'name').text),
        brand: clean(element(block, 'brand').text),
        category: clean(element(block, 'category').text),
        cost: toMoney(price.text),
        currency: clean(attribute(price.attrs, 'currency')).toUpperCase() || defaultCurrency,
        stock: toInt(element(block, 'inventory').text),
        supplier: SUPPLIER,
        sourceUpdatedAt: toIso(element(block, 'updated').text),
        sourceRow: index + 1,
      },
    });
  });
}
return out;
`;

const validateRows = String.raw`// Marks every row valid or invalid and records why.
return $input.all().map((item) => {
  const row = item.json;
  const reasons = [];

  if (!row.sku) reasons.push('blank SKU');
  if (!row.name) reasons.push('missing name');

  if (row.cost === null || row.cost === undefined) reasons.push('cost missing or not a number');
  else if (row.cost <= 0) reasons.push('cost <= 0');

  if (row.stock === null || row.stock === undefined) reasons.push('stock missing or not a number');
  else if (row.stock < 0) reasons.push('negative stock');

  return { json: { ...row, valid: reasons.length === 0, reason: reasons.join('; ') } };
});
`;

const formatErrors = String.raw`// One flat record per rejected row: ready for a sheet row or a Slack line.
return $input.all().map((item) => ({
  json: {
    recordType: 'error',
    supplier: item.json.supplier,
    row: item.json.sourceRow,
    sku: item.json.sku,
    name: item.json.name,
    cost: item.json.cost,
    stock: item.json.stock,
    reason: item.json.reason,
  },
}));
`;

const mergeDuplicates = String.raw`// Groups valid rows by SKU across suppliers and picks one preferred offer per SKU.
// Preference: in stock first, then lowest cost, then most stock, then supplier name.
const groups = new Map();
for (const item of $input.all()) {
  const row = item.json;
  if (!groups.has(row.sku)) groups.set(row.sku, []);
  groups.get(row.sku).push(row);
}

const out = [];
for (const [sku, offers] of groups) {
  offers.sort(
    (a, b) =>
      Number(b.stock > 0) - Number(a.stock > 0) ||
      a.cost - b.cost ||
      b.stock - a.stock ||
      a.supplier.localeCompare(b.supplier),
  );
  const best = offers[0];
  out.push({
    json: {
      sku,
      name: best.name,
      brand: best.brand,
      category: best.category,
      cost: best.cost,
      currency: best.currency,
      stock: best.stock,
      totalStock: offers.reduce((sum, offer) => sum + offer.stock, 0),
      inStock: best.stock > 0,
      supplier: best.supplier,
      supplierCount: offers.length,
      otherSuppliers: offers.slice(1).map((offer) => ({
        supplier: offer.supplier,
        cost: offer.cost,
        stock: offer.stock,
        sourceUpdatedAt: offer.sourceUpdatedAt,
      })),
      sourceUpdatedAt: best.sourceUpdatedAt,
    },
  });
}

out.sort((a, b) => a.json.sku.localeCompare(b.json.sku));
return out;
`;

const calculatePricing = String.raw`// sellPrice = cost * (1 + markup), done in integer cents and rounded once.
const config = $('Config').first().json;
const markupPercent = Number(config.markupPercent);
const minMarginPercent = Number(config.minMarginPercent);

return $input.all().map((item) => {
  const product = item.json;
  const costCents = Math.round(product.cost * 100);
  const sellCents = Math.round((costCents * (100 + markupPercent)) / 100);
  const marginPercent = sellCents > 0 ? ((sellCents - costCents) / sellCents) * 100 : 0;

  return {
    json: {
      recordType: 'product',
      ...product,
      markupPercent,
      sellPrice: sellCents / 100,
      marginPercent: Math.round(marginPercent * 100) / 100,
      lowMargin: marginPercent < minMarginPercent,
    },
  };
});
`;

const runSummary = String.raw`// Totals for the whole run. Row counts come from "Validate rows" so they are
// correct even when one of the two branches produced nothing.
const rows = $('Validate rows').all().map((item) => item.json);
const products = $input.all().map((item) => item.json).filter((r) => r.recordType === 'product');

const perSupplier = {};
for (const row of rows) {
  const s = (perSupplier[row.supplier] ??= { rowsIn: 0, valid: 0, invalid: 0, preferredFor: 0 });
  s.rowsIn += 1;
  if (row.valid) s.valid += 1;
  else s.invalid += 1;
}
for (const product of products) {
  if (perSupplier[product.supplier]) perSupplier[product.supplier].preferredFor += 1;
}

const valid = rows.filter((row) => row.valid).length;
const invalid = rows.length - valid;
const uniqueSkus = products.length;
const duplicatesMerged = valid - uniqueSkus;
const lowMargin = products.filter((product) => product.lowMargin);

const slackText =
  'Product feed run: ' + rows.length + ' rows in, ' + valid + ' valid, ' + invalid + ' invalid. ' +
  uniqueSkus + ' unique SKUs (' + duplicatesMerged + ' duplicates merged), ' +
  lowMargin.length + ' under minimum margin.';

return [
  {
    json: {
      runAt: new Date().toISOString(),
      rowsIn: rows.length,
      valid,
      invalid,
      uniqueSkus,
      duplicatesMerged,
      lowMarginCount: lowMargin.length,
      lowMarginSkus: lowMargin.map((product) => product.sku),
      perSupplier,
      slackText,
    },
  },
];
`;

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const nodes = [];
const connections = {};
const pinData = {};

function node(name, type, typeVersion, position, parameters = {}, extra = {}) {
  nodes.push({ parameters, id: uuid(name), name, type, typeVersion, position, ...extra });
  return name;
}
const code = (name, position, jsCode, extra) =>
  node(name, 'n8n-nodes-base.code', 2, position, { jsCode }, extra);
const sticky = (name, position, width, height, color, content) =>
  node(name, 'n8n-nodes-base.stickyNote', 1, position, { content, width, height, color });

function connect(from, to, { output = 0, input = 0 } = {}) {
  const main = ((connections[from] ??= { main: [] }).main);
  while (main.length <= output) main.push([]);
  main[output].push({ node: to, type: 'main', index: input });
}

const cfg = (field) => `={{ $('Config').first().json.${field} }}`;
const ROW = { a: 200, b: 400, c: 600 };

// 1. Triggers
node('Manual Trigger', 'n8n-nodes-base.manualTrigger', 1, [0, 300]);
node(
  'Schedule Trigger',
  'n8n-nodes-base.scheduleTrigger',
  1.2,
  [0, 500],
  { rule: { interval: [{ field: 'hours', hoursInterval: 1 }] } },
  { disabled: true, notes: 'Production path. Enable to run the feed every hour.' },
);

// 2. Config
const assign = (name, value, type) => ({ id: uuid(`config:${name}`), name, value, type });
node('Config', 'n8n-nodes-base.set', 3.4, [260, 400], {
  assignments: {
    assignments: [
      assign('markupPercent', 35, 'number'),
      assign('minMarginPercent', 25, 'number'),
      assign('currency', 'USD', 'string'),
      assign('useSampleData', true, 'boolean'),
      assign('supplierAUrl', 'https://supplier-a.example.com/api/products', 'string'),
      assign('supplierBUrl', 'https://supplier-b.example.com/export/products.csv', 'string'),
      assign('supplierCUrl', 'https://supplier-c.example.com/feeds/products.xml', 'string'),
      assign('googleSheetId', 'REPLACE_WITH_GOOGLE_SHEET_ID', 'string'),
      assign('slackChannel', '#product-feed', 'string'),
    ],
  },
  options: {},
});
connect('Manual Trigger', 'Config');
connect('Schedule Trigger', 'Config');

// 3 + 4. Supplier branches: HTTP (disabled) -> Sample -> Normalize
const textResponse = { response: { response: { responseFormat: 'text', outputPropertyName: 'data' } } };
const suppliers = [
  { key: 'a', letter: 'A', format: 'JSON', urlField: 'supplierAUrl', options: {}, sample: sampleA, normalize: normalizeA },
  { key: 'b', letter: 'B', format: 'CSV', urlField: 'supplierBUrl', options: textResponse, sample: { data: sampleB }, normalize: normalizeB },
  { key: 'c', letter: 'C', format: 'XML', urlField: 'supplierCUrl', options: textResponse, sample: { data: sampleC }, normalize: normalizeC },
];

node('Merge supplier feeds', 'n8n-nodes-base.merge', 3.2, [1340, 400], { mode: 'append', numberInputs: 3 });

suppliers.forEach((s, index) => {
  const http = node(
    `HTTP: Supplier ${s.letter} (${s.format})`,
    'n8n-nodes-base.httpRequest',
    4.2,
    [540, ROW[s.key]],
    { url: `={{ $json.${s.urlField} }}`, options: s.options },
    { disabled: true, notes: `Live feed. Enable and set useSampleData = false in Config to fetch ${s.urlField}.` },
  );
  const sample = code(`Sample: Supplier ${s.letter}`, [780, ROW[s.key]], sampleCode(`Supplier ${s.letter}`, s.sample));
  const normalize = code(`Normalize Supplier ${s.letter}`, [1060, ROW[s.key]], s.normalize);

  pinData[sample] = [{ json: s.sample }];
  connect('Config', http);
  connect(http, sample);
  connect(sample, normalize);
  connect(normalize, 'Merge supplier feeds', { input: index });
});

// 6 + 7. Validate and split
code('Validate rows', [1580, 400], validateRows);
node('Row is valid?', 'n8n-nodes-base.if', 2.2, [1820, 400], {
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [
      {
        id: uuid('if:valid'),
        leftValue: '={{ $json.valid }}',
        rightValue: '',
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      },
    ],
    combinator: 'and',
  },
  options: {},
});
connect('Merge supplier feeds', 'Validate rows');
connect('Validate rows', 'Row is valid?');

// 9 + 10. Valid branch
code('Merge duplicates by SKU', [2120, 240], mergeDuplicates);
code('Calculate pricing', [2360, 240], calculatePricing);
connect('Row is valid?', 'Merge duplicates by SKU', { output: 0 });
connect('Merge duplicates by SKU', 'Calculate pricing');

// 8. Error branch
code('Format error report', [2120, 720], formatErrors);
node(
  'Notify feed errors',
  'n8n-nodes-base.slack',
  2.3,
  [2380, 630],
  {
    select: 'channel',
    channelId: { __rl: true, mode: 'name', value: cfg('slackChannel') },
    text:
      "={{ $('Format error report').all().length }} supplier feed row(s) rejected:\n" +
      "{{ $('Format error report').all().map((i) => '- ' + i.json.supplier + ' row ' + i.json.row + ': ' + i.json.reason).join('\\n') }}",
    otherOptions: {},
  },
  { disabled: true, executeOnce: true, notes: 'Disabled for the offline demo. Needs a Slack credential.' },
);
node(
  'Append to Errors tab',
  'n8n-nodes-base.googleSheets',
  4.5,
  [2380, 810],
  {
    operation: 'append',
    documentId: { __rl: true, mode: 'id', value: cfg('googleSheetId') },
    sheetName: { __rl: true, mode: 'name', value: 'Errors' },
    columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
    options: {},
  },
  { disabled: true, notes: 'Disabled for the offline demo. Needs a Google Sheets credential.' },
);
connect('Row is valid?', 'Format error report', { output: 1 });
connect('Format error report', 'Notify feed errors');
connect('Format error report', 'Append to Errors tab');

// 11. Outputs (all disabled)
const productColumns = {
  sku: '={{ $json.sku }}',
  name: '={{ $json.name }}',
  brand: '={{ $json.brand }}',
  category: '={{ $json.category }}',
  cost: '={{ $json.cost }}',
  sell_price: '={{ $json.sellPrice }}',
  margin_percent: '={{ $json.marginPercent }}',
  low_margin: '={{ $json.lowMargin }}',
  currency: '={{ $json.currency }}',
  stock: '={{ $json.stock }}',
  total_stock: '={{ $json.totalStock }}',
  supplier: '={{ $json.supplier }}',
  other_suppliers: '={{ JSON.stringify($json.otherSuppliers) }}',
  source_updated_at: '={{ $json.sourceUpdatedAt }}',
};
node(
  'Upsert products',
  'n8n-nodes-base.postgres',
  2.6,
  [2700, 200],
  {
    operation: 'upsert',
    schema: { __rl: true, mode: 'list', value: 'public' },
    table: { __rl: true, mode: 'name', value: 'products' },
    columns: {
      mappingMode: 'defineBelow',
      value: productColumns,
      matchingColumns: ['sku'],
      schema: [],
      attemptToConvertTypes: false,
      convertFieldsToString: false,
    },
    options: {},
  },
  { disabled: true, notes: 'Disabled for the offline demo. Needs a Postgres credential and a products table.' },
);
node(
  'Update product feed tab',
  'n8n-nodes-base.googleSheets',
  4.5,
  [2700, 380],
  {
    operation: 'appendOrUpdate',
    documentId: { __rl: true, mode: 'id', value: cfg('googleSheetId') },
    sheetName: { __rl: true, mode: 'name', value: 'Product Feed' },
    columns: { mappingMode: 'defineBelow', value: productColumns, matchingColumns: ['sku'], schema: [] },
    options: {},
  },
  { disabled: true, notes: 'Disabled for the offline demo. Needs a Google Sheets credential.' },
);
connect('Calculate pricing', 'Upsert products');
connect('Calculate pricing', 'Update product feed tab');

// 12. Run summary. Both branches meet in an append Merge so the summary runs after each has finished.
node('Collect results', 'n8n-nodes-base.merge', 3.2, [2700, 620], { mode: 'append' });
code('Run summary', [2940, 620], runSummary);
node(
  'Feed run summary',
  'n8n-nodes-base.slack',
  2.3,
  [3180, 620],
  {
    select: 'channel',
    channelId: { __rl: true, mode: 'name', value: cfg('slackChannel') },
    text: '={{ $json.slackText }}',
    otherOptions: {},
  },
  { disabled: true, notes: 'Disabled for the offline demo. Needs a Slack credential.' },
);
connect('Calculate pricing', 'Collect results', { input: 0 });
connect('Format error report', 'Collect results', { input: 1 });
connect('Collect results', 'Run summary');
connect('Run summary', 'Feed run summary');

// Sticky notes
sticky('Note: Overview', [-100, -160], 1040, 180, 5,
  '# Multi-Vendor Product Feed Automation\nThree supplier feeds (JSON, CSV, XML) → one schema → validation with an error branch → cross-supplier dedupe → pricing → Postgres, Google Sheets and Slack.\n**Offline demo:** sample feeds are embedded and pinned. Nodes that need credentials or a network are disabled.');
sticky('Note: Ingest', [200, 60], 740, 700, 4,
  '## 1. Ingest\n**Config** holds markup, minimum margin, currency and the feed URLs. Each supplier has a live HTTP Request (disabled) followed by a Sample node that returns the embedded feed while `useSampleData` is true.');
sticky('Note: Normalize', [980, 60], 260, 700, 6,
  '## 2. Normalize\nJSON, CSV and XML are parsed into one schema. SKUs are trimmed and uppercased; money is snapped to cents.');
sticky('Note: Validate', [1280, 60], 700, 700, 3,
  '## 3. Validate\nAll rows are merged, then each is marked valid or invalid with a reason: blank SKU, missing name, cost <= 0, negative stock. The IF node sends valid rows up and invalid rows down.');
sticky('Note: Merge and price', [2040, 60], 520, 400, 4,
  '## 4. Merge and price\nOne record per SKU. Preferred supplier = lowest cost with stock > 0; the rest go to `otherSuppliers`. Sell price = cost × (1 + markup), with a minimum-margin flag.');
sticky('Note: Errors', [2040, 500], 520, 480, 2,
  '## 5. Errors\nRejected rows become an error report (supplier, row, reason) for Slack and the Errors sheet tab.');
sticky('Note: Outputs', [2620, 60], 760, 920, 7,
  '## 6. Outputs\nPostgres upsert on `sku`, Google Sheets feed tab and Slack summary are disabled until credentials are added. **Run summary** reports the totals for every run.');

const workflow = {
  id: WORKFLOW_ID,
  name: 'Multi-Vendor Product Feed Automation',
  nodes,
  connections,
  pinData,
  active: false,
  settings: { executionOrder: 'v1', saveManualExecutions: true },
  versionId: uuid('version'),
  meta: { templateCredsSetupCompleted: true },
  tags: [],
};

const outFile = resolve(root, 'workflows', 'multi-vendor-product-feed.json');
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(workflow, null, 2) + '\n');
console.log(`Wrote ${outFile} (${nodes.length} nodes)`);
