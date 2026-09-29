// Rosie reaches the world only through the factory (DESIGN_AUTHORITY E1, E5, S1, M1): Home Assistant through the
// gateway's home-assistant route, models through the factory model API, Discord replies through the discord route,
// schedules through the control plane. Every call carries only the run token; nothing has a direct fallback.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const RUN_TOKEN = 'fake-run-token-for-tests';
const NOT_A_SECRET = 'fake-credential-must-not-be-sent';

const seen = [];
let modelReplies = [];
let mailbox = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    const send = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url.startsWith('/models/v1/chat/completions')) return send(200, modelReplies.shift() ?? { choices: [{ message: { role: 'assistant', content: 'Beep boop!' } }] });
    if (req.url === '/home-assistant/api/states') {
      return send(200, [
        { entity_id: 'sensor.zander_litter_waste_drawer', state: '95', attributes: { friendly_name: 'Zander waste drawer' } },
        { entity_id: 'sensor.lexi_litter_status_code', state: 'offline', attributes: {} },
        { entity_id: 'light.bar', state: 'off', attributes: { friendly_name: 'Bar light' } },
      ]);
    }
    if (req.url.startsWith('/home-assistant/api/services/')) return send(200, []);
    if (req.url.startsWith('/discord/channels/')) return send(200, { id: '1' });
    if (req.url.startsWith('/cp/api/v1/schedules')) return send(200, { ok: true, schedules: [] });
    if (req.url.startsWith('/cp/api/v1/runs/run-1/heartbeat')) return send(200, { ok: true });
    if (req.url.startsWith('/cp/api/v1/runs/run-1/mailbox')) {
      const next = mailbox.shift();
      if (typeof next === 'number') return send(next, { error: 'x' });
      return send(200, { ok: true, message: next ?? null });
    }
    send(404, { error: 'unknown' });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const gw = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const worker = await import('../worker.mjs');

const FACTORY_ENV = ['FACTORY_RUN_TOKEN', 'FACTORY_URL', 'FACTORY_MODEL_BASE_URL', 'HOME_ASSISTANT_BASE_URL', 'DISCORD_BASE_URL', 'FACTORY_MODEL'];
function setEnv(overrides = {}) {
  for (const k of FACTORY_ENV) delete process.env[k];
  Object.assign(process.env, {
    FACTORY_RUN_TOKEN: RUN_TOKEN,
    FACTORY_URL: `${gw}/cp`,
    FACTORY_MODEL_BASE_URL: `${gw}/models/v1`,
    HOME_ASSISTANT_BASE_URL: `${gw}/home-assistant/`,
    DISCORD_BASE_URL: `${gw}/discord`,
    // Credentials that must never be used even if present in the environment.
    HA_LONG_LIVED_TOKEN: NOT_A_SECRET,
    ROSIE_DISCORD_BOT_TOKEN: NOT_A_SECRET,
    XAI_API_KEY: NOT_A_SECRET,
    ...overrides,
  });
  for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete process.env[k];
}

function assertOnlyRunToken() {
  assert.ok(seen.length > 0);
  for (const r of seen) {
    assert.equal(r.headers.authorization, `Bearer ${RUN_TOKEN}`, `${r.method} ${r.url}`);
    assert.equal(JSON.stringify(r).includes(NOT_A_SECRET), false, `${r.method} ${r.url} leaked a credential`);
  }
}

beforeEach(() => {
  seen.length = 0;
  modelReplies = [];
  mailbox = [];
  setEnv();
});

test('a Discord turn uses the factory model API, runs tools over the home-assistant route, and replies via the discord route', async () => {
  modelReplies = [
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_kitty_litter_status', arguments: '{}' } }] } }] },
    { choices: [{ message: { role: 'assistant', content: 'Zander needs a drawer change!' } }] },
  ];
  const reply = await worker.handleTurn({ agentId: 'rosie', channelId: '42', messageId: 'm', content: '<@123> how is the litter?', authorId: 'a' });
  assert.equal(reply, 'Zander needs a drawer change!');

  const model = seen.filter((r) => r.url === '/models/v1/chat/completions');
  assert.equal(model.length, 2);
  const first = JSON.parse(model[0].body);
  assert.equal(first.model, 'claude-sonnet-4-5');
  assert.ok(first.tools.some((t) => t.function.name === 'get_kitty_litter_status'));
  assert.equal(first.messages.at(-1).content, 'how is the litter?');
  const second = JSON.parse(model[1].body);
  assert.equal(second.messages.at(-1).role, 'tool');
  assert.match(second.messages.at(-1).content, /nearly full/);

  assert.ok(seen.some((r) => r.url === '/home-assistant/api/states'));
  const discord = seen.filter((r) => r.url === '/discord/channels/42/messages');
  assert.equal(discord.length, 1);
  assert.equal(JSON.parse(discord[0].body).content, 'Zander needs a drawer change!');
  assertOnlyRunToken();
});

test('FACTORY_MODEL overrides the cartridge preference (M2)', async () => {
  setEnv({ FACTORY_MODEL: 'claude-haiku-4-5' });
  await worker.handleTurn({ content: 'hello' });
  assert.equal(JSON.parse(seen.find((r) => r.url === '/models/v1/chat/completions').body).model, 'claude-haiku-4-5');
});

test('when the model API fails, the deterministic fallback still answers over the home-assistant route', async () => {
  setEnv({ FACTORY_MODEL_BASE_URL: `${gw}/nope` });
  const reply = await worker.handleTurn({ content: 'turn the bar light on', channelId: '7' });
  assert.match(reply, /bar lights \*\*ON\*\*/);
  const svc = seen.find((r) => r.url === '/home-assistant/api/services/light/turn_on');
  assert.deepEqual(JSON.parse(svc.body), { entity_id: 'light.bar' });
  assert.ok(seen.some((r) => r.url === '/discord/channels/7/messages'));
  assertOnlyRunToken();
});

test('without the gateway routes Rosie calls nothing directly (E1)', async () => {
  setEnv({ HOME_ASSISTANT_BASE_URL: undefined, DISCORD_BASE_URL: undefined, FACTORY_MODEL_BASE_URL: undefined });
  await assert.rejects(worker.hassGetStates('bar'), /HOME_ASSISTANT_BASE_URL is not set/);
  const reply = await worker.handleTurn({ content: 'how is the litter?', channelId: '9' });
  assert.match(reply, /couldn't reach Home Assistant/);
  assert.equal(await worker.postDiscordReply('9', 'hi'), false);
  assert.equal(seen.length, 0);
});

test('schedules go to the control plane with the run token, scoped to rosie', async () => {
  await worker.factoryListSchedules();
  await worker.factoryCreateSchedule('Noon litter', '0 12 * * *', 'check litter', undefined, '42');
  assert.equal(seen[0].url, '/cp/api/v1/schedules?agent=rosie');
  const created = JSON.parse(seen[1].body);
  assert.equal(created.agentId, undefined);
  assert.equal(created.channelId, '42');
  assertOnlyRunToken();
});

test('the warm session exits on the done message (GAP-030)', async () => {
  mailbox = [{ id: 'm1', payload: { content: 'hello again' } }, { id: 'done', payload: null }];
  const handled = [];
  const why = await worker.warmSession({ base: `${gw}/cp/api/v1/runs/run-1`, idleTimeoutMs: 60_000, handle: async (p) => handled.push(p), sleep: async () => {} });
  assert.equal(why, 'done');
  assert.deepEqual(handled, [{ content: 'hello again' }]);
});

test('the warm session stops when the run is over and backs off on errors (GAP-030)', async () => {
  mailbox = [500, 500, 500, 401];
  const sleeps = [];
  const why = await worker.warmSession({ base: `${gw}/cp/api/v1/runs/run-1`, idleTimeoutMs: 60_000, handle: async () => {}, sleep: async (ms) => sleeps.push(ms) });
  assert.equal(why, 'run_over');
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
});

test('the worker, cartridge and image hold no credential, provider path, or private host', () => {
  const src = readFileSync(`${root}worker.mjs`, 'utf8');
  for (const bad of ['api.x.ai', 'discord.com', 'XAI_API_KEY', 'ANTHROPIC_API_KEY', 'HA_LONG_LIVED_TOKEN', 'ROSIE_DISCORD_BOT_TOKEN', 'DISCORD_BOT_TOKEN', 'HASS_URL', 'dkr.ecr']) {
    assert.equal(src.includes(bad), false, `worker.mjs mentions ${bad}`);
  }
  const cartridge = readFileSync(`${root}cartridge.yaml`, 'utf8');
  assert.match(cartridge, /requires: \[\]/);
  assert.equal(/XAI_API_KEY|HA_LONG_LIVED_TOKEN|HASS_URL|\d{12}/.test(cartridge), false);
  assert.match(cartridge, /secretRef: ROSIE_DISCORD_BOT_TOKEN/);
  assert.match(readFileSync(`${root}Dockerfile`, 'utf8'), /ENTRYPOINT \["node", "\/opt\/factory-hydrate\/dist\/shim\.js", "--"\]/);
});
