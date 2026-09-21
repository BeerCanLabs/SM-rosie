#!/usr/bin/env node
import { mkdirSync } from 'node:fs';

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
} = process.env;

console.log(`[rosie] woke; mind at ${dir}`);

// Home Assistant Client
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
  const q = (search || '').toLowerCase().trim();
  return states
    .filter((s) => {
      if (!q) return true;
      const id = s.entity_id.toLowerCase();
      const name = (s.attributes?.friendly_name || '').toLowerCase();
      return id.includes(q) || name.includes(q);
    })
    .slice(0, 30)
    .map((s) => ({
      entity_id: s.entity_id,
      name: s.attributes?.friendly_name || s.entity_id,
      state: s.state,
      unit: s.attributes?.unit_of_measurement || '',
    }));
}

async function hassCallService(domain, service, entityId) {
  const url = `${HASS_URL.replace(/\/$/, '')}/api/services/${domain}/${service}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${HA_LONG_LIVED_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ entity_id: entityId }),
  });
  if (!res.ok) {
    throw new Error(`Home Assistant service call failed: ${res.status} ${await res.text()}`);
  }
  return await res.json();
}

// Home Assistant Conversation / Jarvis API
async function hassProcessConversation(text, agentId) {
  const url = `${HASS_URL.replace(/\/$/, '')}/api/conversation/process`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${HA_LONG_LIVED_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      ...(agentId ? { agent_id: agentId } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`Home Assistant conversation call failed: ${res.status} ${await res.text()}`);
  }
  return await res.json();
}

// Fallback logic for common commands if LLM is unavailable
async function fallbackHandler(userText) {
  const lower = userText.toLowerCase();

  // 1. Frame batteries
  if (lower.includes('frame') && lower.includes('battery')) {
    const states = await hassGetStates('frame');
    const batterySensors = states.filter((s) => s.entity_id.includes('battery') || s.name.toLowerCase().includes('battery'));
    if (batterySensors.length === 0) {
      return "Beep boop! I couldn't find any battery sensors for the frames in Home Assistant, Dale!";
    }
    const lines = batterySensors.map((s) => `• **${s.name}**: ${s.state}${s.unit ? ' ' + s.unit : '%'}`);
    return `Beep boop! Here are the current battery levels for your frames, Dale:\n${lines.join('\n')}\n*Dusting circuits complete!* 🧹`;
  }

  // 2. Bar light
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

  return `Hello Dale! Rosie here, at your service! I heard: "${userText}". I can check battery levels or toggle your smart home devices!`;
}

// Function to handle a single conversational turn
async function handleTurn(input) {
  const userQuery = (input.content || '').replace(/^!rosie\s*/i, '').replace(/<@!?\d+>/g, '').trim();
  let replyText = '';

  // 1. Try Home Assistant Assist / Conversation API first (Jarvis AI -> Local HA Intents)
  if (HA_LONG_LIVED_TOKEN && userQuery) {
    const candidateAgents = [
      'conversation.google_ai_conversation', // Jarvis AI (Gemini)
      'conversation.home_assistant',         // Built-in HA Intent Parser
    ];
    for (const agentId of candidateAgents) {
      try {
        console.log(`[rosie] Trying Home Assistant conversation agent: ${agentId}`);
        const convRes = await hassProcessConversation(userQuery, agentId);
        const speech = convRes?.response?.speech?.plain?.speech;
        const respType = convRes?.response?.response_type;
        const errorCode = convRes?.response?.data?.code;

        // Skip if error, no match, or quota/credit exhaustion
        if (
          respType === 'error' ||
          errorCode === 'no_intent_match' ||
          (speech && (speech.includes('prepayment credits are depleted') || speech.includes('RESOURCE_EXHAUSTED')))
        ) {
          console.log(`[rosie] Agent ${agentId} unable to handle: ${errorCode || respType || speech}`);
          continue;
        }

        if (speech) {
          replyText = speech;
          console.log(`[rosie] Successfully handled by HA ${agentId}: "${replyText}"`);
          break;
        }
      } catch (err) {
        console.warn(`[rosie] Failed calling HA agent ${agentId}:`, err);
      }
    }
  }

  // 2. Process query with xAI Grok (if key present and HA didn't answer)
  if (!replyText && XAI_API_KEY && userQuery) {
    try {
      console.log(`[rosie] Reasoning with xAI Grok for: "${userQuery}"`);
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
              },
              required: ['domain', 'service', 'entity_id'],
            },
          },
        },
      ];

      const messages = [
        {
          role: 'system',
          content:
            "You are Rosie, Dale's cheerful, capable, robotic maid from the Jetsons managing his Home Assistant smart home. Always execute the appropriate tools to fetch live states or control devices before answering. Be concise, warm, helpful, and keep responses formatted nicely for Discord with markdown bullets and emojis.",
        },
        { role: 'user', content: userQuery },
      ];

      for (let turn = 0; turn < 4; turn++) {
        const llmRes = await fetch('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${XAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'grok-4.20-0309-non-reasoning',
            messages,
            tools,
            temperature: 0.3,
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
                toolResult = await hassCallService(args.domain, args.service, args.entity_id);
              } else {
                toolResult = { error: 'Unknown tool' };
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
      console.error('[rosie] Grok error, falling back:', err);
    }
  }

  // 3. If still empty, run deterministic fallback
  if (!replyText) {
    replyText = await fallbackHandler(userQuery);
  }

  // 4. Post reply to Discord
  console.log(`[rosie] Sending reply to Discord channel ${input.channelId}...`);
  const botToken = ROSIE_DISCORD_BOT_TOKEN;
  if (botToken) {
    const discordRes = await fetch(`https://discord.com/api/v10/channels/${input.channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: replyText }),
    });
    console.log(`[rosie] Discord API response: ${discordRes.status}`);
  }
}

// Main Rosie execution loop
async function main() {
  if (!FACTORY_URL || !FACTORY_RUN_ID || !FACTORY_RUN_TOKEN) {
    console.log('[rosie] Running outside Factory context, exiting.');
    return;
  }

  const base = `${FACTORY_URL.replace(/\/$/, '')}/api/v1/runs/${FACTORY_RUN_ID}`;
  const auth = { Authorization: `Bearer ${FACTORY_RUN_TOKEN}` };

  // 1. Fetch initial run input
  const resInput = await fetch(`${base}/input`, { headers: auth });
  const { input } = await resInput.json();
  console.log('[rosie] received initial input:', input);

  if (input && input.channelId) {
    await handleTurn(input);
  }

  // 2. Stay warm in mailbox loop for 5 minutes (300,000 ms) of idle time
  const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
  let lastActivity = Date.now();
  console.log('[rosie] Entering warm session loop (5-minute idle window)...');

  async function fetchMailbox(timeoutMs = 15000) {
    try {
      const res = await fetch(`${base}/mailbox?timeout=${timeoutMs}`, { headers: auth });
      if (!res.ok) return null;
      const data = await res.json();
      return data.message?.payload || null;
    } catch (err) {
      console.warn('[rosie] Error polling mailbox:', err);
      return null;
    }
  }

  while (Date.now() - lastActivity < IDLE_TIMEOUT_MS) {
    const nextMsg = await fetchMailbox(15000);
    if (nextMsg && nextMsg.channelId) {
      console.log('[rosie] Follow-up message received from mailbox:', nextMsg);
      lastActivity = Date.now();
      await handleTurn(nextMsg);
    }
  }

  console.log('[rosie] 5 minutes idle with no activity; scaling to zero.');
  // Report result back to Factory Control Plane to gracefully close run
  const res = await fetch(`${base}/result`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'succeeded', output: { completed: true } }),
  });
  console.log(`[rosie] reported result to factory: ${res.status}`);
}

main().catch(async (err) => {
  console.error('[rosie] fatal worker error:', err);
  process.exit(1);
});
