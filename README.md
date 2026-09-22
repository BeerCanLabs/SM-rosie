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
