#!/usr/bin/env python3
"""
Triad & Governance Report Generator — BeerCanLabs Standard.

Generates the canonical Skill ↔ System ↔ Secret ↔ HITL/Hold report table
for an agent cartridge.
"""

import sys
import yaml
from pathlib import Path
from typing import Any, Dict, List

def format_hold(hold_val: Any) -> str:
    """Format hold/HITL value for human-readable display."""
    if not hold_val or hold_val == "none":
        return "Autonomous"
    if hold_val == "required":
        return "**Required**"
    return f"**Required** ({hold_val})"

def format_injection(injection: Any, route: Any = None) -> str:
    """Format injection/auth mechanism."""
    if injection == "gatekeeper-egress":
        return f"Gatekeeper-Egress Route (`{route}`)" if route else "Gatekeeper-Egress Route"
    if injection == "gatekeeper-ingress":
        return "Gatekeeper-Ingress Trigger"
    if injection == "keymaster":
        return f"Keymaster Connection (`{route}`)" if route else "Keymaster Connection"
    if injection == "container":
        return "Container Environment"
    if injection == "none":
        return "None (Public / No Auth)"
    return str(injection) if injection else "Gatekeeper-Egress Route"

def generate_triad_report(cartridge_dir: Path | str = ".") -> str:
    """Read cartridge.yaml and generate markdown triad report."""
    cartridge_path = Path(cartridge_dir) / "cartridge.yaml"
    if not cartridge_path.exists():
        raise FileNotFoundError(f"Cartridge manifest not found at {cartridge_path}")

    with open(cartridge_path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}

    agent_id = data.get("id", "unknown")
    agent_name = data.get("name", agent_id.capitalize())
    agent_role = data.get("role", "Unspecified Role")

    skills_raw = data.get("skills", [])
    rows: List[Dict[str, str]] = []

    for skill in skills_raw:
        if isinstance(skill, str):
            skill_id = skill
            skill_name = skill
            desc = ""
            system = "Unspecified"
            secret = "Unspecified"
            hold = "Autonomous"
            injection = "Gatekeeper-Egress"
        elif isinstance(skill, dict):
            skill_id = skill.get("id", "")
            skill_name = skill.get("name") or skill_id
            desc = skill.get("description", "")
            system = skill.get("system") or "Unspecified (compact format)"
            secret = skill.get("secretRef") or "None"
            hold = format_hold(skill.get("hold", "none"))
            injection = format_injection(skill.get("injection", "gatekeeper-egress"), skill.get("route"))
        else:
            continue

        rows.append({
            "skill": f"`{skill_id}`",
            "system": system,
            "secret": f"`{secret}`" if secret != "None" and not secret.startswith("Unspecified") else secret,
            "hold": hold,
            "injection": injection,
            "purpose": desc or skill_name
        })

    lines = [
        f"# Triad & Governance Report: {agent_name} (`{agent_id}`)",
        f"> **Role:** {agent_role}  ",
        f"> **Source:** `cartridge.yaml`",
        "",
        "| Skill | System | Secret (Requirement) | HITL / Hold | Auth Mechanism / Injection | Purpose |",
        "| :--- | :--- | :--- | :--- | :--- | :--- |",
    ]

    for r in rows:
        lines.append(f"| {r['skill']} | {r['system']} | {r['secret']} | {r['hold']} | {r['injection']} | {r['purpose']} |")

    return "\n".join(lines)

def main():
    target_dir = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else "."
    try:
        report = generate_triad_report(target_dir)
        print(report)
    except Exception as e:
        print(f"Error generating report: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
