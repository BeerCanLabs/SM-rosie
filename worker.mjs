// Rosie: Home Assistant infrastructure manager & robotic maid.
//
// How Rosie reaches the world (agent-factory DESIGN_AUTHORITY §6.3.1 E1/E5, §6.3.2 S1, §6.9 M1). Every outbound
// call goes through the factory, carries only this run's token, and has no direct fallback:
//   Home Assistant  -> $HOME_ASSISTANT_BASE_URL   gateway `home-assistant` route; the gateway injects the HA token
//   models          -> $FACTORY_MODEL_BASE_URL    factory model API (OpenAI Chat Completions format), metered
//   Discord replies -> $DISCORD_BASE_URL          gateway `discord` route; the gateway injects Rosie's bot token
//   schedules       -> $FACTORY_URL/api/v1/...    control plane, authenticated by the run token
// Rosie holds no credential. Discord presence belongs to the Doorman; Rosie never opens a Discord connection.
// The factory shim (Dockerfile ENTRYPOINT) sets these variables, hydrates $MEMORY_DIR and heartbeats.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_ID = 'rosie';
/** Used only if neither FACTORY_MODEL nor cartridge.yaml `model:` names one. Policy decides what Rosie gets (M2). */
const DEFAULT_MODEL = 'claude-sonnet-4-5';

/** A factory-provided variable is missing: Rosie refuses instead of reaching the service another way (E1). */
export class NotConfigured extends Error {}

function requireEnv(name, why) {
  const v = (process.env[name] || '').trim();
  if (!v) throw new NotConfigured(`${name} is not set: ${why}`);
  return v;
}

const trimSlash = (s) => s.replace(/\/+$/, '');
const runToken = () => requireEnv('FACTORY_RUN_TOKEN', 'this run has no factory identity');
const bearer = () => ({ Authorization: `Bearer ${runToken()}` });

// --- Home Assistant Operations (gateway `home-assistant` route) ---

function haBase() {
  return trimSlash(requireEnv('HOME_ASSISTANT_BASE_URL', "Home Assistant is reached only through the factory gateway's home-assistant route"));
}

async function haFetch(path, init = {}) {
  const base = haBase();
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...bearer(), 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
}

export async function hassGetStates(search) {
  const res = await haFetch('/api/states');
  if (!res.ok) {
    throw new Error(`Home Assistant error: ${res.status} ${await res.text()}`);
  }
  const states = await res.json();
  const rawQ = (search || '').toLowerCase().trim();
  const terms = rawQ.split(/\s+/).filter(Boolean);

  let filtered = states;
  if (terms.length > 0) {
    const allMatches = states.filter((s) => {
      const id = s.entity_id.toLowerCase();
      const name = (s.attributes?.friendly_name || '').toLowerCase();
      return terms.every((t) => id.includes(t) || name.includes(t));
    });
    filtered = allMatches.length > 0 ? allMatches : states.filter((s) => {
      const id = s.entity_id.toLowerCase();
      const name = (s.attributes?.friendly_name || '').toLowerCase();
      return terms.some((t) => id.includes(t) || name.includes(t));
    });
  }

  return filtered
    .slice(0, 40)
    .map((s) => ({
      entity_id: s.entity_id,
      name: s.attributes?.friendly_name || s.entity_id,
      state: s.state,
      unit: s.attributes?.unit_of_measurement || '',
      charging: s.attributes?.charging !== undefined ? s.attributes.charging : undefined,
    }));
}

export async function hassCallService(domain, service, entityId, serviceData = {}) {
  const body = entityId ? { entity_id: entityId, ...serviceData } : serviceData;
  const res = await haFetch(`/api/services/${domain}/${service}`, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) {
    throw new Error(`Home Assistant service call failed: ${res.status} ${await res.text()}`);
  }
  return await res.json();
}

async function hassGetAutomations(search) {
  const res = await haFetch('/api/states');
  if (!res.ok) throw new Error(`Home Assistant error: ${res.status} ${await res.text()}`);
  const states = await res.json();
  const automations = states.filter((s) => s.entity_id.startsWith('automation.'));
  const rawQ = (search || '').toLowerCase().trim();
  const terms = rawQ.split(/\s+/).filter(Boolean);

  const filtered = terms.length === 0
    ? automations
    : automations.filter((a) => {
        const id = a.entity_id.toLowerCase();
        const name = (a.attributes?.friendly_name || '').toLowerCase();
        return terms.every((t) => id.includes(t) || name.includes(t));
      });

  return filtered.slice(0, 30).map((a) => ({
    entity_id: a.entity_id,
    id: a.attributes?.id || a.entity_id.replace(/^automation\./, ''),
    name: a.attributes?.friendly_name || a.entity_id,
    state: a.state,
    last_triggered: a.attributes?.last_triggered || 'never',
    mode: a.attributes?.mode || 'single',
  }));
}

async function hassGetAutomationConfig(automationId) {
  const cleanId = automationId.replace(/^automation\./, '');
  const res = await haFetch(`/api/config/automation/config/${encodeURIComponent(cleanId)}`);
  if (!res.ok) {
    // If direct ID lookup fails, find the numeric ID in states
    const automations = await hassGetAutomations(cleanId);
    if (automations.length > 0 && automations[0].id && automations[0].id !== cleanId) {
      return await hassGetAutomationConfig(automations[0].id);
    }
    throw new Error(`Automation config not found for ${automationId}: ${res.status}`);
  }
  return await res.json();
}

async function hassCreateOrUpdateAutomation(automationId, config) {
  const cleanId = (automationId || `auto_${Date.now()}`).replace(/^automation\./, '');
  const payload = {
    ...config,
    id: cleanId,
  };
  const res = await haFetch(`/api/config/automation/config/${encodeURIComponent(cleanId)}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Failed to save automation: ${res.status} ${await res.text()}`);

  // Reload automations in Home Assistant
  await haFetch('/api/services/automation/reload', { method: 'POST' });

  return {
    success: true,
    automation_id: cleanId,
    entity_id: `automation.${cleanId}`,
    config: payload,
  };
}

async function hassToggleAutomation(entityId, enable) {
  const service = enable ? 'turn_on' : 'turn_off';
  return await hassCallService('automation', service, entityId);
}

async function hassTriggerAutomation(entityId) {
  return await hassCallService('automation', 'trigger', entityId);
}

async function hassTroubleshoot(entityId, hoursBack = 24) {
  let stateInfo = null;
  try {
    const sRes = await haFetch(`/api/states/${encodeURIComponent(entityId)}`);
    if (sRes.ok) stateInfo = await sRes.json();
  } catch (err) {
    stateInfo = { error: String(err) };
  }

  let logbook = [];
  try {
    const startTime = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString();
    const lRes = await haFetch(`/api/logbook?entity=${encodeURIComponent(entityId)}&start_time=${encodeURIComponent(startTime)}`);
    if (lRes.ok) logbook = await lRes.json();
  } catch (err) {
    logbook = [{ error: String(err) }];
  }

  let autoConfig = null;
  if (entityId.startsWith('automation.')) {
    try {
      const id = stateInfo?.attributes?.id || entityId.replace(/^automation\./, '');
      autoConfig = await hassGetAutomationConfig(id);
    } catch {}
  }

  return {
    entity_id: entityId,
    state: stateInfo?.state,
    attributes: stateInfo?.attributes,
    last_changed: stateInfo?.last_changed,
    last_updated: stateInfo?.last_updated,
    automationConfig: autoConfig,
    recentLogbookEvents: (Array.isArray(logbook) ? logbook : []).slice(-15),
  };
}

export async function hassGetKittyLitterStatus() {
  const res = await haFetch('/api/states');
  if (!res.ok) throw new Error(`HA states failed: ${res.status}`);
  const states = await res.json();
  const byId = Object.fromEntries(states.map((s) => [s.entity_id, s]));

  const zander = {
    cat: 'Zander',
    litter_level: byId['sensor.zander_litter_litter_level']?.state,
    waste_drawer: byId['sensor.zander_litter_waste_drawer']?.state,
    status_code: byId['sensor.zander_litter_status_code']?.state,
    pet_weight: byId['sensor.zander_litter_pet_weight']?.state,
    full_automation: byId['automation.zander_litter_full']?.state,
  };

  const lexi = {
    cat: 'Lexi',
    litter_level: byId['sensor.lexi_litter_litter_level']?.state,
    waste_drawer: byId['sensor.lexi_litter_waste_drawer']?.state,
    status_code: byId['sensor.lexi_litter_status_code']?.state,
    pet_weight: byId['sensor.lexi_litter_pet_weight']?.state,
  };

  const alerts = [];
  const zWaste = parseInt(zander.waste_drawer || '0', 10);
  const lWaste = parseInt(lexi.waste_drawer || '0', 10);
  if (zWaste >= 90) alerts.push(`⚠️ Zander's waste drawer is nearly full (${zander.waste_drawer}%)`);
  if (lWaste >= 90) alerts.push(`⚠️ Lexi's waste drawer is nearly full (${lexi.waste_drawer}%)`);
  if (lexi.status_code === 'offline') alerts.push("⚠️ Lexi's Litter-Robot is currently reporting offline");

  return {
    timestamp: new Date().toISOString(),
    zander,
    lexi,
    alerts,
  };
}

// --- Dynamic Scheduling Operations (control plane, run token) ---

function factoryBase() {
  return trimSlash(requireEnv('FACTORY_URL', 'the factory injects the control-plane URL'));
}

export async function factoryCreateSchedule(name, cron, prompt, timezone = 'America/Los_Angeles', channelId) {
  // No agentId in the body: the control plane attributes the schedule to the run token's agent.
  const res = await fetch(`${factoryBase()}/api/v1/schedules`, {
    method: 'POST',
    headers: { ...bearer(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, cron, prompt, timezone, channelId }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Schedule creation failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

export async function factoryListSchedules() {
  const res = await fetch(`${factoryBase()}/api/v1/schedules?agent=${AGENT_ID}`, { headers: bearer(), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`List schedules failed: ${res.status}`);
  return await res.json();
}

async function factoryCancelSchedule(scheduleId) {
  const res = await fetch(`${factoryBase()}/api/v1/schedules/${encodeURIComponent(scheduleId)}`, {
    method: 'DELETE',
    headers: bearer(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Cancel schedule failed: ${res.status}`);
  return await res.json();
}

// --- Factory model API (M1) ---

/** Rosie's preferred model (M2): FACTORY_MODEL, else cartridge.yaml `model:`, else the default. */
export function preferredModel() {
  if (process.env.FACTORY_MODEL) return process.env.FACTORY_MODEL;
  try {
    const m = readFileSync(new URL('./cartridge.yaml', import.meta.url), 'utf8').match(/^model:\s*["']?([^"'\s#]+)/m);
    if (m) return m[1];
  } catch {}
  return DEFAULT_MODEL;
}

function modelApiConfigured() {
  return Boolean((process.env.FACTORY_MODEL_BASE_URL || '').trim() && (process.env.FACTORY_RUN_TOKEN || '').trim());
}

async function chatCompletion(body) {
  const base = trimSlash(requireEnv('FACTORY_MODEL_BASE_URL', 'models are reached only through the factory model API'));
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { ...bearer(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`factory model API ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// --- Discord replies (gateway `discord` route) ---

export async function postDiscordReply(channelId, text) {
  const base = (process.env.DISCORD_BASE_URL || '').trim();
  if (!base) {
    console.warn("[rosie] DISCORD_BASE_URL is not set: Discord is reached only through the factory gateway's discord route; not replying.");
    return false;
  }
  const res = await fetch(`${trimSlash(base)}/channels/${encodeURIComponent(channelId)}/messages`, {
    method: 'POST',
    headers: { ...bearer(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text.slice(0, 1900) }),
    signal: AbortSignal.timeout(15_000),
  });
  console.log(`[rosie] Discord API response: ${res.status}`);
  return res.ok;
}

// Fallback logic for common commands if LLM is unavailable
async function fallbackHandler(userText, channelId) {
  const lower = userText.toLowerCase();

  // 1. Kitty litter
  if (lower.includes('litter') || lower.includes('cat') || lower.includes('zander') || lower.includes('lexi')) {
    const status = await hassGetKittyLitterStatus();
    let text = `🐾 **Kitty Litter Status Report**:\n\n`;
    text += `• **Zander**: Litter Level: ${status.zander.litter_level || '?'}% | Waste Drawer: ${status.zander.waste_drawer || '?'}% | Pet Weight: ${status.zander.pet_weight || '?'} lbs\n`;
    text += `• **Lexi**: Litter Level: ${status.lexi.litter_level || '?'}% | Waste Drawer: ${status.lexi.waste_drawer || '?'}% | Status: ${status.lexi.status_code || 'normal'}\n`;
    if (status.alerts.length > 0) {
      text += `\n**Alerts**:\n${status.alerts.map((a) => `• ${a}`).join('\n')}\n`;
    }
    return text;
  }

  // 2. Frame batteries
  if (lower.includes('frame') && lower.includes('battery')) {
    const states = await hassGetStates('frame battery');
    const batterySensors = states.filter((s) => s.entity_id.includes('battery') || s.name.toLowerCase().includes('battery'));
    if (batterySensors.length === 0) {
      return "Beep boop! I couldn't find any battery sensors for the frames in Home Assistant, Dale!";
    }
    const lines = batterySensors.map((s) => `• **${s.name}**: ${s.state}${s.unit ? ' ' + s.unit : '%'}`);
    return `Beep boop! Here are the current battery levels for your frames, Dale:\n${lines.join('\n')}\n*Dusting circuits complete!* 🧹`;
  }

  // 3. Bar light
  if (lower.includes('bar') && (lower.includes('light') || lower.includes('on') || lower.includes('off'))) {
    const turnOn = !lower.includes('off');
    const action = turnOn ? 'turn_on' : 'turn_off';
    try {
      await hassCallService('light', action, 'light.bar');
    } catch {
      await hassCallService('switch', action, 'switch.bar_light');
    }
    return `Right away, Dale! I've switched the bar lights **${turnOn ? 'ON' : 'OFF'}** for you! 🍸✨`;
  }

  return `Hello Dale! Rosie here, at your service! I heard: "${userText}". I manage your Home Assistant smart home, automations, sensors, and action schedules!`;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_entity_states',
      description: 'Search device and sensor states from Home Assistant (e.g. frame, battery, bar, light, temperature).',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Keyword to search for in entity names or IDs.' },
        },
        required: ['search'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'call_service',
      description: 'Turn on, turn off, or control devices in Home Assistant.',
      parameters: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Domain such as light, switch, climate, automation.' },
          service: { type: 'string', description: 'Service such as turn_on, turn_off, toggle.' },
          entity_id: { type: 'string', description: 'Target entity ID such as light.bar or switch.bar_light.' },
          service_data: { type: 'object', description: 'Optional extra payload/parameters.' },
        },
        required: ['domain', 'service', 'entity_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_automations',
      description: 'List existing Home Assistant automations with their entity_id, friendly name, state (on/off), and last_triggered time.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Optional filter by name or ID.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_automation_config',
      description: 'Retrieve the complete configuration schema (triggers, conditions, actions) of an automation.',
      parameters: {
        type: 'object',
        properties: {
          automation_id: { type: 'string', description: 'The automation ID or entity_id (e.g. 1731385375615 or automation.piano_lights_off).' },
        },
        required: ['automation_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_or_update_automation',
      description: 'Create a new automation or update an existing automation in Home Assistant, then reload automations.',
      parameters: {
        type: 'object',
        properties: {
          automation_id: { type: 'string', description: 'Unique automation slug/id (e.g. piano_lights_off or morning_routine).' },
          config: {
            type: 'object',
            description: 'Full automation config including alias, description, triggers, conditions, actions, and mode.',
            properties: {
              alias: { type: 'string', description: 'Friendly title of the automation.' },
              description: { type: 'string', description: 'Purpose of the automation.' },
              triggers: { type: 'array', description: 'Trigger definitions.' },
              conditions: { type: 'array', description: 'Condition definitions.' },
              actions: { type: 'array', description: 'Action definitions.' },
              mode: { type: 'string', enum: ['single', 'restart', 'queued', 'parallel'], description: 'Execution mode.' },
            },
            required: ['alias', 'triggers', 'actions'],
          },
        },
        required: ['automation_id', 'config'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'toggle_automation',
      description: 'Enable or disable a Home Assistant automation.',
      parameters: {
        type: 'object',
        properties: {
          entity_id: { type: 'string', description: 'Automation entity ID, e.g. automation.piano_lights_off.' },
          enable: { type: 'boolean', description: 'true to enable (turn_on), false to disable (turn_off).' },
        },
        required: ['entity_id', 'enable'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'trigger_automation',
      description: 'Manually trigger an automation to run its actions immediately.',
      parameters: {
        type: 'object',
        properties: {
          entity_id: { type: 'string', description: 'Automation entity ID, e.g. automation.piano_lights_off.' },
        },
        required: ['entity_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'troubleshoot_device_or_automation',
      description: 'Troubleshoot a device, sensor, or automation by inspecting live state, attributes, last_changed, and recent logbook events.',
      parameters: {
        type: 'object',
        properties: {
          entity_id: { type: 'string', description: 'Target entity ID (e.g. automation.piano_lights_off, sensor.zander_litter_waste_drawer).' },
          hours_back: { type: 'number', description: 'How many hours of logbook history to inspect (default 24).' },
        },
        required: ['entity_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_kitty_litter_status',
      description: 'Get comprehensive real-time status of the Litter-Robots for cats Zander and Lexi (litter level %, waste drawer %, status codes, pet weights, alerts).',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_schedule',
      description: 'Schedule a recurring or one-time action in the Factory Control Plane to run automatically (e.g. check kitty litter levels at noon every day and report to Discord).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Descriptive name for the schedule (e.g. Daily Noon Kitty Litter Report).' },
          cron: { type: 'string', description: 'Standard 5-field cron expression (e.g. "0 12 * * *" for noon every day, "0 6 * * *" for 6am daily).' },
          prompt: { type: 'string', description: 'Action prompt to execute when the schedule triggers.' },
          timezone: { type: 'string', description: 'Timezone for cron evaluation, defaults to "America/Los_Angeles".' },
        },
        required: ['name', 'cron', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_schedules',
      description: 'List all dynamic schedules registered for Rosie in the Factory Control Plane.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_schedule',
      description: 'Cancel and delete a scheduled action by schedule ID.',
      parameters: {
        type: 'object',
        properties: {
          schedule_id: { type: 'string', description: 'Schedule ID to cancel.' },
        },
        required: ['schedule_id'],
      },
    },
  },
];

async function runTool(fnName, args, channelId) {
  if (fnName === 'get_entity_states') return await hassGetStates(args.search);
  if (fnName === 'call_service') return await hassCallService(args.domain, args.service, args.entity_id, args.service_data);
  if (fnName === 'list_automations') return await hassGetAutomations(args.search);
  if (fnName === 'get_automation_config') return await hassGetAutomationConfig(args.automation_id);
  if (fnName === 'create_or_update_automation') return await hassCreateOrUpdateAutomation(args.automation_id, args.config);
  if (fnName === 'toggle_automation') return await hassToggleAutomation(args.entity_id, args.enable);
  if (fnName === 'trigger_automation') return await hassTriggerAutomation(args.entity_id);
  if (fnName === 'troubleshoot_device_or_automation') return await hassTroubleshoot(args.entity_id, args.hours_back);
  if (fnName === 'get_kitty_litter_status') return await hassGetKittyLitterStatus();
  if (fnName === 'create_schedule') return await factoryCreateSchedule(args.name, args.cron, args.prompt, args.timezone, channelId);
  if (fnName === 'list_schedules') return await factoryListSchedules();
  if (fnName === 'cancel_schedule') return await factoryCancelSchedule(args.schedule_id);
  return { error: `Unknown tool: ${fnName}` };
}

// Single conversational turn handler
export async function handleTurn(input) {
  const userQuery = String(input?.content || input?.message || '').replace(/^!rosie\s*/i, '').replace(/<@!?\d+>/g, '').trim();
  const channelId = input?.channelId || input?.channel_id;
  let replyText = '';

  const now = new Date();
  const localTime = now.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'full',
    timeStyle: 'full',
  });
  const utcTime = now.toISOString();
  const dayOfWeek = now.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long' });

  // Process query with the factory model API and live HA/scheduler tools
  if (modelApiConfigured() && userQuery) {
    try {
      const model = preferredModel();
      console.log(`[rosie] Reasoning with model (${model}) for: "${userQuery}"`);

      const messages = [
        {
          role: 'system',
          content: `You are Rosie, Dale's cheerful, highly capable robotic maid from the Jetsons managing his Home Assistant smart home infrastructure.
Temporal Context:
- Local Time: ${localTime} (${dayOfWeek}, America/Los_Angeles / Pacific Time)
- UTC Time: ${utcTime}
Always execute your tools to inspect real-time states, automations, schedules, or troubleshooting traces before answering.
Provide direct, accurate, and neatly formatted Discord responses with bullets, status indicators, and appropriate Jetsons-style charm.`,
        },
        { role: 'user', content: userQuery },
      ];

      for (let turn = 0; turn < 8; turn++) {
        const data = await chatCompletion({ model, messages, tools: TOOLS, temperature: 0.2 });
        const choice = data.choices?.[0]?.message;
        if (!choice) break;

        if (choice.tool_calls && choice.tool_calls.length > 0) {
          messages.push(choice);
          for (const tc of choice.tool_calls) {
            const fnName = tc.function.name;
            let toolResult;
            try {
              const args = JSON.parse(tc.function.arguments || '{}');
              console.log(`[rosie] Calling tool ${fnName} with args:`, args);
              toolResult = await runTool(fnName, args, channelId);
            } catch (err) {
              toolResult = { error: err instanceof Error ? err.message : String(err) };
            }

            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: JSON.stringify(toolResult),
            });
          }
        } else {
          replyText = choice.content;
          break;
        }
      }
    } catch (err) {
      console.error('[rosie] Model error, falling back:', err instanceof Error ? err.message : err);
    }
  }

  if (!replyText) {
    try {
      replyText = await fallbackHandler(userQuery, channelId);
    } catch (err) {
      console.error('[rosie] Fallback failed:', err instanceof Error ? err.message : err);
      replyText = "Beep boop! I couldn't reach Home Assistant just now, Dale. Please try again in a moment! 🧹";
    }
  }

  // Post reply to Discord if the turn came from a channel and there is something to say
  if (channelId && replyText) {
    console.log(`[rosie] Sending reply to Discord channel ${channelId}...`);
    try {
      await postDiscordReply(channelId, replyText);
    } catch (err) {
      console.error('[rosie] Discord reply failed:', err instanceof Error ? err.message : err);
    }
  }

  return replyText;
}

async function readInput() {
  if (process.env.FACTORY_INPUT) {
    try {
      return JSON.parse(process.env.FACTORY_INPUT);
    } catch {
      return { content: process.env.FACTORY_INPUT };
    }
  }
  const inputFile = process.env.FACTORY_INPUT_FILE || '/tmp/factory-input.json';
  if (existsSync(inputFile)) {
    try {
      return JSON.parse(readFileSync(inputFile, 'utf8'));
    } catch {
      return { content: readFileSync(inputFile, 'utf8') };
    }
  }
  const { FACTORY_URL, FACTORY_RUN_ID, FACTORY_RUN_TOKEN } = process.env;
  if (FACTORY_URL && FACTORY_RUN_ID && FACTORY_RUN_TOKEN) {
    const base = `${trimSlash(FACTORY_URL)}/api/v1/runs/${FACTORY_RUN_ID}`;
    try {
      const res = await fetch(`${base}/input`, { headers: bearer(), signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const data = await res.json();
        return data.input || data;
      }
    } catch (err) {
      console.warn('[rosie] Failed to fetch input from factory:', err instanceof Error ? err.message : err);
    }
  }
  return { message: 'healthcheck', type: 'http' };
}

async function writeResult(result) {
  // Under the factory shim FACTORY_RESULT_FILE is set and the shim reports the file; post directly only without it.
  const underShim = Boolean(process.env.FACTORY_RESULT_FILE);
  const resultFile = process.env.FACTORY_RESULT_FILE || '/tmp/factory-result.json';
  try {
    writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf8');
  } catch {}
  if (underShim) return;

  const { FACTORY_URL, FACTORY_RUN_ID, FACTORY_RUN_TOKEN } = process.env;
  if (FACTORY_URL && FACTORY_RUN_ID && FACTORY_RUN_TOKEN) {
    const base = `${trimSlash(FACTORY_URL)}/api/v1/runs/${FACTORY_RUN_ID}`;
    try {
      const res = await fetch(`${base}/result`, {
        method: 'POST',
        headers: { ...bearer(), 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
        signal: AbortSignal.timeout(10_000),
      });
      console.log(`[rosie] reported result to factory: ${res.status}`);
    } catch (err) {
      console.warn('[rosie] Failed to report result to factory:', err instanceof Error ? err.message : err);
    }
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Mailbox/heartbeat statuses that mean this run is over: stop instead of polling again (GAP-030). */
const RUN_OVER = new Set([401, 403, 404, 409, 410]);

/**
 * Warm session: long-poll the run's mailbox for follow-up turns until the idle window expires. Exits on the
 * control plane's `done` message and when the run is over, and backs off on errors, so it can never spin (GAP-030).
 * Returns why it stopped: 'idle' | 'done' | 'run_over'.
 */
export async function warmSession({ base, idleTimeoutMs, handle, sleep = defaultSleep, now = Date.now }) {
  const auth = { ...bearer(), 'Content-Type': 'application/json' };
  const minBackoff = 1_000;
  const maxBackoff = 30_000;
  let backoff = minBackoff;
  let lastActivity = now();

  const pause = async () => {
    await sleep(backoff);
    backoff = Math.min(backoff * 2, maxBackoff);
  };

  while (now() - lastActivity < idleTimeoutMs) {
    const pollMs = Math.max(0, Math.min(idleTimeoutMs - (now() - lastActivity), 20_000));
    try {
      const hb = await fetch(`${base}/heartbeat`, { method: 'POST', headers: auth, body: JSON.stringify({ ok: true }), signal: AbortSignal.timeout(10_000) });
      if (RUN_OVER.has(hb.status)) return 'run_over';
    } catch {}

    const started = now();
    let res;
    try {
      res = await fetch(`${base}/mailbox?timeout=${pollMs}`, { headers: auth, signal: AbortSignal.timeout(pollMs + 10_000) });
    } catch {
      await pause();
      continue;
    }
    if (RUN_OVER.has(res.status)) return 'run_over';
    if (!res.ok) {
      await pause();
      continue;
    }
    const data = await res.json().catch(() => null);
    const msg = data?.message;
    if (msg?.id === 'done') return 'done';
    if (!msg || msg.payload == null) {
      // An empty answer that came back early (not a full long-poll) must not turn into a tight loop.
      if (now() - started < Math.min(pollMs, minBackoff)) await pause();
      continue;
    }
    backoff = minBackoff;
    console.log('[rosie] Follow-up message received from mailbox');
    lastActivity = now();
    await handle(msg.payload);
  }
  return 'idle';
}

// Main Rosie execution loop
export async function main() {
  const dir = process.env.MEMORY_DIR || '/tmp/rosie-mind';
  mkdirSync(dir, { recursive: true });
  console.log(`[rosie] woke; mind at ${dir}`);
  console.log('[rosie] Head of Smart Home & Robotic Maid waking up...');
  const initialInput = await readInput();
  const resultText = await handleTurn(initialInput);

  const warmDownSeconds = parseInt(process.env.WARM_DOWN_SECONDS || '3600', 10);
  const { FACTORY_URL, FACTORY_RUN_ID, FACTORY_RUN_TOKEN } = process.env;
  if (FACTORY_URL && FACTORY_RUN_ID && FACTORY_RUN_TOKEN) {
    console.log(`[rosie] Entering warm session loop (${warmDownSeconds}s idle window)...`);
    const why = await warmSession({
      base: `${trimSlash(FACTORY_URL)}/api/v1/runs/${FACTORY_RUN_ID}`,
      idleTimeoutMs: warmDownSeconds * 1000,
      handle: handleTurn,
    });
    console.log(`[rosie] Warm session ended (${why}); scaling to zero.`);
  }

  await writeResult({
    status: 'succeeded',
    output: {
      agent: 'Rosie',
      role: 'Home Assistant Infrastructure Manager & Robotic Maid',
      summary: resultText,
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[rosie] fatal worker error:', err);
    process.exit(1);
  });
}
