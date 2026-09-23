import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const dir = process.env.MEMORY_DIR || '/tmp/rosie-mind';
mkdirSync(dir, { recursive: true });

const {
  FACTORY_URL,
  FACTORY_RUN_ID,
  FACTORY_RUN_TOKEN,
  HASS_URL = 'https://ha.dalesackrider.com/',
  HA_LONG_LIVED_TOKEN,
  ROSIE_DISCORD_BOT_TOKEN,
  XAI_API_KEY,
  ANTHROPIC_API_KEY,
} = process.env;

console.log(`[rosie] woke; mind at ${dir}`);

// --- Home Assistant Operations ---

async function hassGetStates(search) {
  const url = `${HASS_URL.replace(/\/$/, '')}/api/states`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${HA_LONG_LIVED_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
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

async function hassCallService(domain, service, entityId, serviceData = {}) {
  const url = `${HASS_URL.replace(/\/$/, '')}/api/services/${domain}/${service}`;
  const body = entityId ? { entity_id: entityId, ...serviceData } : serviceData;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${HA_LONG_LIVED_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Home Assistant service call failed: ${res.status} ${await res.text()}`);
  }
  return await res.json();
}

async function hassGetAutomations(search) {
  const url = `${HASS_URL.replace(/\/$/, '')}/api/states`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${HA_LONG_LIVED_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
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
  const url = `${HASS_URL.replace(/\/$/, '')}/api/config/automation/config/${encodeURIComponent(cleanId)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${HA_LONG_LIVED_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
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
  const url = `${HASS_URL.replace(/\/$/, '')}/api/config/automation/config/${encodeURIComponent(cleanId)}`;
  const payload = {
    ...config,
    id: cleanId,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${HA_LONG_LIVED_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Failed to save automation: ${res.status} ${await res.text()}`);

  // Reload automations in Home Assistant
  await fetch(`${HASS_URL.replace(/\/$/, '')}/api/services/automation/reload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${HA_LONG_LIVED_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

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
  const base = HASS_URL.replace(/\/$/, '');
  const auth = { Authorization: `Bearer ${HA_LONG_LIVED_TOKEN}`, 'Content-Type': 'application/json' };

  let stateInfo = null;
  try {
    const sRes = await fetch(`${base}/api/states/${encodeURIComponent(entityId)}`, { headers: auth });
    if (sRes.ok) stateInfo = await sRes.json();
  } catch (err) {
    stateInfo = { error: String(err) };
  }

  let logbook = [];
  try {
    const startTime = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString();
    const lRes = await fetch(`${base}/api/logbook?entity=${encodeURIComponent(entityId)}&start_time=${encodeURIComponent(startTime)}`, { headers: auth });
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

async function hassGetKittyLitterStatus() {
  const base = HASS_URL.replace(/\/$/, '');
  const res = await fetch(`${base}/api/states`, {
    headers: { Authorization: `Bearer ${HA_LONG_LIVED_TOKEN}`, 'Content-Type': 'application/json' },
  });
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

// --- Dynamic Scheduling Operations ---

async function factoryCreateSchedule(name, cron, prompt, timezone = 'America/Los_Angeles', channelId) {
  const base = (FACTORY_URL || 'http://control-plane.factory.internal:8088').replace(/\/$/, '');
  const res = await fetch(`${base}/api/v1/schedules`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(FACTORY_RUN_TOKEN ? { Authorization: `Bearer ${FACTORY_RUN_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      agentId: 'rosie',
      name,
      cron,
      prompt,
      timezone,
      channelId,
    }),
  });
  if (!res.ok) throw new Error(`Schedule creation failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function factoryListSchedules() {
  const base = (FACTORY_URL || 'http://control-plane.factory.internal:8088').replace(/\/$/, '');
  const res = await fetch(`${base}/api/v1/schedules?agentId=rosie`, {
    headers: FACTORY_RUN_TOKEN ? { Authorization: `Bearer ${FACTORY_RUN_TOKEN}` } : {},
  });
  if (!res.ok) throw new Error(`List schedules failed: ${res.status}`);
  return await res.json();
}

async function factoryCancelSchedule(scheduleId) {
  const base = (FACTORY_URL || 'http://control-plane.factory.internal:8088').replace(/\/$/, '');
  const res = await fetch(`${base}/api/v1/schedules/${encodeURIComponent(scheduleId)}`, {
    method: 'DELETE',
    headers: FACTORY_RUN_TOKEN ? { Authorization: `Bearer ${FACTORY_RUN_TOKEN}` } : {},
  });
  if (!res.ok) throw new Error(`Cancel schedule failed: ${res.status}`);
  return await res.json();
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

// Single conversational turn handler
async function handleTurn(input) {
  const userQuery = (input.content || input.message || '').replace(/^!rosie\s*/i, '').replace(/<@!?\d+>/g, '').trim();
  const channelId = input.channelId || input.channel_id;
  let replyText = '';

  const now = new Date();
  const localTime = now.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'full',
    timeStyle: 'full',
  });
  const utcTime = now.toISOString();
  const dayOfWeek = now.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long' });

  // Process query with reasoning model and live HA/scheduler tools
  if ((XAI_API_KEY || ANTHROPIC_API_KEY) && userQuery) {
    try {
      const model = process.env.XAI_MODEL || 'grok-4.20-0309-reasoning';
      console.log(`[rosie] Reasoning with model (${model}) for: "${userQuery}"`);

      const tools = [
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
        const llmRes = await fetch('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${XAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages,
            tools,
            temperature: 0.2,
          }),
        });

        const data = await llmRes.json();
        const choice = data.choices?.[0]?.message;
        if (!choice) break;

        if (choice.tool_calls && choice.tool_calls.length > 0) {
          messages.push(choice);
          for (const tc of choice.tool_calls) {
            const fnName = tc.function.name;
            const args = JSON.parse(tc.function.arguments || '{}');
            console.log(`[rosie] Calling tool ${fnName} with args:`, args);

            let toolResult;
            try {
              if (fnName === 'get_entity_states') {
                toolResult = await hassGetStates(args.search);
              } else if (fnName === 'call_service') {
                toolResult = await hassCallService(args.domain, args.service, args.entity_id, args.service_data);
              } else if (fnName === 'list_automations') {
                toolResult = await hassGetAutomations(args.search);
              } else if (fnName === 'get_automation_config') {
                toolResult = await hassGetAutomationConfig(args.automation_id);
              } else if (fnName === 'create_or_update_automation') {
                toolResult = await hassCreateOrUpdateAutomation(args.automation_id, args.config);
              } else if (fnName === 'toggle_automation') {
                toolResult = await hassToggleAutomation(args.entity_id, args.enable);
              } else if (fnName === 'trigger_automation') {
                toolResult = await hassTriggerAutomation(args.entity_id);
              } else if (fnName === 'troubleshoot_device_or_automation') {
                toolResult = await hassTroubleshoot(args.entity_id, args.hours_back);
              } else if (fnName === 'get_kitty_litter_status') {
                toolResult = await hassGetKittyLitterStatus();
              } else if (fnName === 'create_schedule') {
                toolResult = await factoryCreateSchedule(args.name, args.cron, args.prompt, args.timezone, channelId);
              } else if (fnName === 'list_schedules') {
                toolResult = await factoryListSchedules();
              } else if (fnName === 'cancel_schedule') {
                toolResult = await factoryCancelSchedule(args.schedule_id);
              } else {
                toolResult = { error: `Unknown tool: ${fnName}` };
              }
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
      console.error('[rosie] Model error, falling back:', err);
    }
  }

  if (!replyText) {
    replyText = await fallbackHandler(userQuery, channelId);
  }

  // Post reply to Discord if channelId present
  if (channelId) {
    console.log(`[rosie] Sending reply to Discord channel ${channelId}...`);
    const botToken = ROSIE_DISCORD_BOT_TOKEN;
    if (botToken) {
      const chunks = [replyText.slice(0, 1900)];
      for (const chunk of chunks) {
        const discordRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bot ${botToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content: chunk }),
        });
        console.log(`[rosie] Discord API response: ${discordRes.status}`);
      }
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
  if (FACTORY_URL && FACTORY_RUN_ID && FACTORY_RUN_TOKEN) {
    const base = `${FACTORY_URL.replace(/\/$/, '')}/api/v1/runs/${FACTORY_RUN_ID}`;
    const auth = { Authorization: `Bearer ${FACTORY_RUN_TOKEN}` };
    try {
      const res = await fetch(`${base}/input`, { headers: auth });
      if (res.ok) {
        const data = await res.json();
        return data.input || data;
      }
    } catch (err) {
      console.warn('[rosie] Failed to fetch input from factory:', err);
    }
  }
  return { message: 'healthcheck', type: 'http' };
}

async function writeResult(result) {
  const resultFile = process.env.FACTORY_RESULT_FILE || '/tmp/factory-result.json';
  try {
    writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf8');
  } catch {}

  if (FACTORY_URL && FACTORY_RUN_ID && FACTORY_RUN_TOKEN) {
    const base = `${FACTORY_URL.replace(/\/$/, '')}/api/v1/runs/${FACTORY_RUN_ID}`;
    const auth = { Authorization: `Bearer ${FACTORY_RUN_TOKEN}`, 'Content-Type': 'application/json' };
    try {
      const res = await fetch(`${base}/result`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(result),
      });
      console.log(`[rosie] reported result to factory: ${res.status}`);
    } catch (err) {
      console.warn('[rosie] Failed to report result to factory:', err);
    }
  }
}

// Main Rosie execution loop
async function main() {
  console.log('[rosie] Head of Smart Home & Robotic Maid waking up...');
  const initialInput = await readInput();
  console.log('[rosie] received input:', initialInput);
  const resultText = await handleTurn(initialInput);

  const warmDownSeconds = parseInt(process.env.WARM_DOWN_SECONDS || '3600', 10);
  const idleTimeoutMs = warmDownSeconds * 1000;
  let lastActivity = Date.now();

  if (FACTORY_URL && FACTORY_RUN_ID && FACTORY_RUN_TOKEN) {
    const base = `${FACTORY_URL.replace(/\/$/, '')}/api/v1/runs/${FACTORY_RUN_ID}`;
    const auth = { Authorization: `Bearer ${FACTORY_RUN_TOKEN}`, 'Content-Type': 'application/json' };

    console.log(`[rosie] Entering warm session loop (${warmDownSeconds}s idle window)...`);

    async function sendHeartbeat() {
      try {
        await fetch(`${base}/heartbeat`, {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ ok: true }),
        });
      } catch {}
    }

    async function fetchMailbox(timeoutMs = 15000) {
      try {
        const res = await fetch(`${base}/mailbox?timeout=${timeoutMs}`, { headers: auth });
        if (!res.ok) return null;
        const data = await res.json();
        return data.message?.payload || null;
      } catch (err) {
        return null;
      }
    }

    // Send initial heartbeat to announce we are actively warm
    await sendHeartbeat();

    while (Date.now() - lastActivity < idleTimeoutMs) {
      const remainingMs = idleTimeoutMs - (Date.now() - lastActivity);
      if (remainingMs <= 0) break;
      const pollMs = Math.min(remainingMs, 20000);
      await sendHeartbeat();
      const nextMsg = await fetchMailbox(pollMs);
      if (nextMsg) {
        console.log('[rosie] Follow-up message received from mailbox:', nextMsg);
        lastActivity = Date.now();
        await handleTurn(nextMsg);
      }
    }
  }

  console.log('[rosie] Warm window expired; scaling to zero.');
  await writeResult({
    status: 'succeeded',
    output: {
      agent: 'Rosie',
      role: 'Home Assistant Infrastructure Manager & Robotic Maid',
      summary: resultText,
    },
  });
}

main().catch(async (err) => {
  console.error('[rosie] fatal worker error:', err);
  process.exit(1);
});
