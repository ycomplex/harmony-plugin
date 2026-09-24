// B-1081 -- capture the REAL Harmony MCP server's tools/list as mocks/<server>/_tools.json.
//
// `claude plugin eval --mocks record` serves every mocked tool from its markdown mock file; without
// `_tools.json` it warns "served with a permissive schema and no description" and the model sees
// tools with no descriptions -- not the skill's real operating conditions. Tool schemas are not
// intellectual property (they are the server's public contract), so the file is COMMITTED and
// re-captured whenever the tool surface changes.
//
//   npm run build && node evals/clarify-replay/scripts/capture-tools.mjs
//
// Needs the same env the server needs to start (HARMONY_API_TOKEN at least; the staging triple for
// the staging channel). It calls tools/list only -- nothing on the board is read or written.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const server = process.argv[2] ?? join(root, 'dist', 'index.js');
const out = join(here, '..', 'mocks', 'plugin_harmony-plugin_harmony', '_tools.json');

const transport = new StdioClientTransport({ command: 'node', args: [server], env: process.env, stderr: 'pipe' });
const client = new Client({ name: 'clarify-replay-capture-tools', version: '0' });
await client.connect(transport);
const { tools } = await client.listTools();
await client.close();
writeFileSync(out, `${JSON.stringify({ tools }, null, 2)}\n`);
console.log(`capture-tools: ${tools.length} tool(s) -> ${out}`);
