# Multi-Vendor Product Feed Automation

An n8n workflow that pulls product feeds from three suppliers in three formats (JSON, CSV, XML), normalizes them into one schema, validates every row, routes bad rows to an error branch, merges duplicate SKUs across suppliers, calculates sell prices, and prepares output for Postgres, Google Sheets and Slack.

The demo runs natively on Windows with Node.js only. It needs no supplier endpoints, database, Google or Slack credentials: the sample feeds are embedded in the workflow, and every node that needs a network or a credential is disabled.

## What this demonstrates

- **Multi-format ingestion**: a JSON API, a CSV export and an XML feed, each with its own field names.
- **Normalization**: one schema (`sku`, `name`, `brand`, `category`, `cost`, `currency`, `stock`, `supplier`, `sourceUpdatedAt`), trimmed strings, uppercase SKUs, safe number parsing, money handled in whole cents.
- **Validation with an error branch**: each row is marked valid or invalid with a reason, and invalid rows are reported instead of silently dropped.
- **Cross-supplier dedupe**: one record per SKU, preferred supplier chosen by lowest cost with stock available, alternatives kept in `otherSuppliers`, stock summed.
- **Pricing rules**: configurable markup and a minimum-margin check.
- **Offline testability**: the whole workflow runs from the editor or the command line with no external services.

## Requirements

- Node.js 24 or newer (n8n 2.48.5 requires `>=24.0.0`). Check with `node -v`.

Nothing else. n8n is installed locally into this folder by `npm install`.

## Setup

Run these in PowerShell from this folder:

```powershell
npm install
npm run validate
npm run start
```

`npm install` takes several minutes (n8n is about 2,250 packages). Warnings about deprecated packages and install scripts can be ignored; the demo runs without them.

Then open [http://localhost:5678](http://localhost:5678). On first launch n8n asks you to create a local owner account. It is stored only in this project's `.n8n-data` folder.

`npm run validate` checks the workflow file without starting n8n: every connection points to an existing node, no node name is duplicated, exactly the expected nodes are disabled, every Code node parses, and the embedded sample data matches `samples/`.

## Import the workflow

Use either option.

- **Editor**: in n8n, open **Workflows**, create a new workflow, open the **...** menu and choose **Import from File**, then select `workflows\multi-vendor-product-feed.json`.
- **Command line**: stop n8n first (Ctrl+C), then run:

  ```powershell
  npm run import
  ```

  Start n8n again with `npm run start` and the workflow appears in the list.

## Run it

1. Open **Multi-Vendor Product Feed Automation**.
2. Click **Test workflow** (labelled **Execute workflow** in some versions).
3. Click the **Run summary** node to see the totals.

The sample feeds contain deliberate bad rows. They go down the lower output of **Row is valid?** into the error branch:

| Supplier | Row | Problem | Reason reported |
| --- | --- | --- | --- |
| Supplier A | 6 | "Unlabeled Bottle" has no SKU | `blank SKU` |
| Supplier B | 4 | "Insulated Mug 350ml" has a cost of 0.00 | `cost <= 0` |
| Supplier B | 6 | "Sleeping Pad" has a stock of -3 | `negative stock` |
| Supplier C | 5 | `CK-505` has an empty name | `missing name` |

Expected **Run summary** for the sample data:

| Field | Value |
| --- | --- |
| `rowsIn` | 28 (A 9, B 10, C 9) |
| `valid` | 24 |
| `invalid` | 4 |
| `uniqueSkus` | 16 |
| `duplicatesMerged` | 8 |
| `lowMarginCount` | 1 (`ZT-001`: a 0.07 cost rounds to a 0.09 sell price, a 22.22% margin) |

The nine disabled nodes (greyed out on the canvas) do no work: n8n passes their input straight through in 0 ms, so no HTTP request is made and nothing is written to Postgres, Google Sheets or Slack.

You can also run it without the editor. With n8n stopped and the workflow imported:

```powershell
npm run execute
```

This prints the full execution result as JSON, including the **Run summary** output.

## Screenshots

- **Canvas**: open the workflow, press `1` (or use the **Zoom to fit** button at the bottom left) so every node and sticky note is visible, then capture the editor with the Snipping Tool (`Win + Shift + S`).
- **Successful execution**: after a test run, open the **Executions** tab at the top of the workflow, select the latest successful execution, zoom to fit, and capture the execution graph. Green ticks and item counts appear on the nodes that ran. Click **Run summary** first if you want its output panel in the shot.

## Stop and reset

- **Stop**: press Ctrl+C in the terminal running `npm run start`.
- **Reset**: delete the `.n8n-data` folder. This removes the local owner account, the imported workflow and all executions.

  ```powershell
  Remove-Item -Recurse -Force .n8n-data
  ```

## Going live

1. **Config node**: set `useSampleData` to `false`, replace `supplierAUrl`, `supplierBUrl` and `supplierCUrl` with the real feed URLs, set `googleSheetId` and `slackChannel`, and adjust `markupPercent`, `minMarginPercent` and `currency`. `.env.example` lists the same values as a checklist; the workflow does not read a `.env` file.
2. **Unpin the sample data**: open each **Sample: Supplier X** node and unpin its output. Pinned data replaces a node's output during manual runs.
3. **Enable the ingest nodes**: **HTTP: Supplier A (JSON)**, **HTTP: Supplier B (CSV)**, **HTTP: Supplier C (XML)**. Add authentication on each node if the supplier requires it.
4. **Enable the output nodes and add credentials in n8n** (**Credentials > Add credential**):

   | Node | Credential type | Notes |
   | --- | --- | --- |
   | **Upsert products** | Postgres | Needs a `products` table with a unique `sku` column and the columns mapped in the node. |
   | **Update product feed tab** | Google Sheets OAuth2 | Sheet tab named `Product Feed` with a `sku` header column. |
   | **Append to Errors tab** | Google Sheets OAuth2 | Sheet tab named `Errors`. |
   | **Notify feed errors** | Slack API | Posts one message listing the rejected rows. |
   | **Feed run summary** | Slack API | Posts the run totals. |

5. **Enable the Schedule Trigger** (hourly by default) and activate the workflow.

## Project layout

| Path | Purpose |
| --- | --- |
| `workflows/multi-vendor-product-feed.json` | The importable workflow. |
| `samples/` | The three sample supplier feeds. |
| `scripts/start.mjs` | Runs the local n8n CLI with `N8N_USER_FOLDER=.n8n-data`, `N8N_PORT=5678` and `N8N_DIAGNOSTICS_ENABLED=false`. |
| `scripts/validate-workflow.mjs` | Static checks on the workflow file. |
| `scripts/build-workflow.mjs` | Regenerates the workflow from `samples/` (`npm run build:workflow`). Run it after editing a sample file. |
| `.env.example` | Placeholder names for the live configuration. |
| `.n8n-data/` | Local n8n data, created on first run and ignored by git. |
