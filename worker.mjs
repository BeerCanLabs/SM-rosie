#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.MEMORY_DIR || '/tmp/rosie-mind';
const { FACTORY_URL, FACTORY_RUN_ID, FACTORY_RUN_TOKEN, ROSIE_DISCORD_BOT_TOKEN } = process.env;

mkdirSync(dir, { recursive: true });
console.log(`[rosie] woke; mind at ${dir}`);

if (FACTORY_URL && FACTORY_RUN_ID && FACTORY_RUN_TOKEN) {
  const base = `${FACTORY_URL.replace(/\/$/, '')}/api/v1/runs/${FACTORY_RUN_ID}`;
  const auth = { Authorization: `Bearer ${FACTORY_RUN_TOKEN}` };
  
  // Get input from Doorman
  const resInput = await fetch(`${base}/input`, { headers: auth });
  const { input } = await resInput.json();
  
  console.log('[rosie] received input:', input);
  
  if (input && input.channelId && ROSIE_DISCORD_BOT_TOKEN) {
    // Send message back to Discord
    const replyText = "Hello Dale! I am Rosie, your robotic maid. I am alive in the new Factory PaaS!";
    const discordRes = await fetch(`https://discord.com/api/v10/channels/${input.channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${ROSIE_DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content: replyText })
    });
    
    console.log(`[rosie] Discord API status: ${discordRes.status}`);
  }

  // Report back to Factory
  const res = await fetch(`${base}/result`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'succeeded', output: { replied: true } }),
  });
  console.log(`[rosie] reported result: ${res.status}`);
}
