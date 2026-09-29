// Notion goes through the factory gateway's `notion` route (DESIGN_AUTHORITY §6.3.2 S1, §6.11 K5.5).
// Rosie sends only her run token; she never holds or sends the Notion key, and has no direct path
// to Notion when the route is not configured (E1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const worker = `${root}skills/notion/scripts/notion_worker.py`;
const RUN_TOKEN = 'fake-run-token-for-tests';
const NOT_THE_KEY = 'fake-notion-key-must-not-be-sent';

function run(env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?_proxy|all_proxy|NOTION_BASE_URL|FACTORY_RUN_TOKEN)$/i.test(k)));
  return new Promise((resolve) => {
    const p = spawn('python3', [worker, 'list', '--json'], { env: { ...clean, ...env } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c) => (stdout += c));
    p.stderr.on('data', (c) => (stderr += c));
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('the notion worker calls the gateway route with the run token only', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address();
    const out = await run({ NOTION_BASE_URL: `http://127.0.0.1:${port}/notion/`, FACTORY_RUN_TOKEN: RUN_TOKEN, NOTION_API_KEY: NOT_THE_KEY });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'POST');
    assert.match(seen[0].url, /^\/notion\/v1\/databases\/[^/]+\/query$/);
    assert.equal(seen[0].headers.authorization, `Bearer ${RUN_TOKEN}`);
    assert.equal(seen[0].headers['notion-version'], '2022-06-28');
    assert.equal(JSON.stringify(seen[0]).includes(NOT_THE_KEY), false);
  } finally {
    server.close();
  }
});

test('the notion worker fails clearly without the gateway route', async () => {
  const out = await run({ FACTORY_RUN_TOKEN: RUN_TOKEN, NOTION_API_KEY: NOT_THE_KEY });
  assert.equal(out.code, 2);
  assert.match(out.stderr, /NOTION_BASE_URL/);
});

test('the cartridge and worker hold no Notion key and no direct Notion path', () => {
  assert.equal(readFileSync(`${root}cartridge.yaml`, 'utf8').includes('NOTION_API_KEY'), false);
  const src = readFileSync(worker, 'utf8');
  assert.equal(src.includes('NOTION_API_KEY'), false);
  assert.equal(src.includes('api.notion.com'), false);
});
