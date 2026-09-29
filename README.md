# SM-rosie — Smart Home Infrastructure Manager & Robotic Maid

`SM-rosie` is a portable autonomous agent cartridge for the **BeerCanLabs Agent Factory**.

## 📋 Cartridge Architecture
- [`cartridge.yaml`](cartridge.yaml) — Factory employment contract (schemaVersion 1.0), defining triggers, required secret names, persistence prefix, and compute specs.
- [`soul.md`](soul.md) — Job description, persona directives, and operational boundaries.
- [`bench.yaml`](bench.yaml) — Deterministic quality and regression test cases.
- [`worker.mjs`](worker.mjs) — Runtime task loop following the "New Hire" pattern.
- [`Dockerfile`](Dockerfile) — OCI container packaging.

## 🛠️ Validation
Validate this cartridge against the factory contract specification:
```bash
npx @beercanlabs/contract validate .
```

## How Rosie reaches the world
Every outbound call goes through the factory with the run's token; Rosie holds no credential and has no direct path:

| Service | Rosie calls | Factory path |
| :--- | :--- | :--- |
| Home Assistant | `$HOME_ASSISTANT_BASE_URL/api/...` | gateway `home-assistant` route (injects the HA token) |
| Models | `$FACTORY_MODEL_BASE_URL/chat/completions` | factory model API (OpenAI Chat Completions format, metered) |
| Discord replies | `$DISCORD_BASE_URL/channels/{id}/messages` | gateway `discord` route (injects the bot token) |
| Schedules | `$FACTORY_URL/api/v1/schedules` | control plane |

Discord presence is held by the factory Doorman (the `discord` trigger); Rosie never connects to Discord herself.

## Tests
```bash
npm test
```
