---
name: notion
description: "Single source of truth for Submind agents interacting with The Submind Notion workspace: database hierarchy, schema definitions, task claiming, status lifecycles, and bidirectional task synchronization."
---

# Notion Operations Skill: The Submind

This skill defines the unified standard operating procedure (SOP) and data schema for all Submind agents (Donna, Castle, Switch, Archie, Geordi, Higgins, Draftsman) reading, claiming, updating, and completing tasks in Notion.

---

## 1. Architecture: Data vs. Skills (DRY Principle)

* **Data (State Store):** The real-time operational state of the business lives in Notion under **The Submind Operations Board** database.
* **Skill (The Operating System):** This `SKILL.md` file is the **single source of truth** defining how agents interact with Notion. No agent prompt should hardcode or duplicate Notion schemas or rules.
* **Execution Interface:** Agents interact with Notion through the standard CLI script:
  `python3 /Users/skippy/repos/skippy-matrix/skills/notion/scripts/notion_worker.py <command>`
  or via the Submind MCP gateway.

---

## 2. Workspace Hierarchy & Data Dictionary

### Target Location
* **Workspace:** Dale Sackrider's Space
* **Parent Page:** The Submind (`3d80a48f-fae0-80cf-9e42-d5c8bd2595cd`)
* **Database Title:** `The Submind Operations Board`
* **Database ID:** `3d80a48f-fae0-816b-bc00-e4cba96c85aa`

### Property Schema

| Field Name | Property Type | Permitted Values | Purpose & Agent Rules |
| :--- | :--- | :--- | :--- |
| **`Task`** | `title` | Text | Clear, imperative summary of the work (e.g. `Draft Sunday reflection on WeReadTheBible.com`). |
| **`Status`** | `status` | `Backlog`, `In Progress`, `Blocked`, `Done` | Current lifecycle state. Agents MUST transition this explicitly. |
| **`Agent`** | `select` | `Donna`, `Castle`, `Switch`, `Higgins`, `Archie`, `Geordi`, `Draftsman` | Primary assigned autonomous worker. |
| **`Priority`** | `select` | `Urgent`, `High`, `Normal`, `Low` | Scheduling urgency. `Urgent` tasks trigger priority dispatch. |
| **`Domain`** | `select` | `Executive Suite`, `Content Creation`, `Engineering`, `Real Estate`, `Infrastructure`, `Agent Factory` | Maps to the colony hex zone and functional business domain. |
| **`Target URL`** | `url` | Web URL | Direct link to PR, GitHub issue, deployed URL, or draft. |
| **`Notes`** | `rich_text` | Text | Execution details, blocker explanations, or completion summaries. |

---

## 3. Agent Ownership Matrix

| Agent | Primary Domain | Typical Task Scope |
| :--- | :--- | :--- |
| **Donna** | `Executive Suite` | Personal & executive calendar triage, email coordination, backlog reconciliation, daily Kanban sync. |
| **Castle** | `Content Creation` | Thought leadership, Dale voice profile, dalesackrider.com essays, WeReadTheBible reflections, LinkedIn. |
| **Switch** | `Engineering` | Autonomous software engineering across lab repos, issue worker sweeps, game development, bugfixes. |
| **Higgins** | `Real Estate` | Closing Climb property ops, Stephanie's Daily 25 referral briefings, Motion task prep, deal tracking. |
| **Archie** | `Agent Factory` | Agent factory blueprints, IaC, CI/CD, cross-repo backlog sweeps, platform architecture. |
| **Geordi** | `Infrastructure` | Cloud Run stability, Litestream SQLite replication to GCS, DNS, domain health, SRE monitoring. |
| **Draftsman** | `Agent Factory` | System architect, metadata cataloging, architectural standards, and agent contract specifications. |

---

## 4. Operating Workflows (Lifecycle Protocol)

### Protocol 1: Morning Briefing & Sweep (Queue Discovery)
1. At scheduled briefing times (e.g. 08:00 for Donna, 06:00 for Higgins, 09:00 for Archie) or on invocation, query assigned tasks:
   ```bash
   python3 /Users/skippy/repos/skippy-matrix/skills/notion/scripts/notion_worker.py list --agent <agent_name> --status Backlog
   ```
2. Sort tasks by `Priority` (`Urgent` → `High` → `Normal` → `Low`).

### Protocol 2: Claiming a Task
1. When beginning execution on a task, transition status to `In Progress`:
   ```bash
   python3 /Users/skippy/repos/skippy-matrix/skills/notion/scripts/notion_worker.py update <task_id> --status "In Progress" --notes "Execution initiated"
   ```
2. This immediately updates the colony 3D billboard and informs Dale that work is actively in flight.

### Protocol 3: Logging Blockers
1. If execution requires human approval, secret provisioning, or encounters an unrecoverable failure:
   - Transition status to `Blocked`.
   - Update `Notes` with the exact blocker and question.
   - Alert Dale on Discord.
   ```bash
   python3 /Users/skippy/repos/skippy-matrix/skills/notion/scripts/notion_worker.py update <task_id> --status "Blocked" --notes "Blocked: Awaiting Dale confirmation on..."
   ```

### Protocol 4: Task Completion
1. When work is finished (e.g., PR submitted, draft rendered, database audited):
   - Set `Status` to `Done`.
   - Set `Target URL` with the PR or output link.
   - Add a concise outcome summary in `Notes`.
   ```bash
   python3 /Users/skippy/repos/skippy-matrix/skills/notion/scripts/notion_worker.py complete <task_id> --url "<pr_or_doc_url>" --summary "Outcome summary..."
   ```

### Protocol 5: Creating Follow-Up Tasks
1. If completing a task creates follow-up work for another agent (e.g. Castle finishes a blog post and needs Geordi to verify Cloudflare DNS, or Switch opens a PR and needs Archie review):
   - The agent creates a new task assigned to that agent in `Backlog`:
   ```bash
   python3 /Users/skippy/repos/skippy-matrix/skills/notion/scripts/notion_worker.py create --title "Review PR #42 for agent-garrison" --agent Archie --domain "Agent Factory" --priority High
   ```

---

## 5. Security & Ground Rules

1. **Never Put Secrets in Notion:** Never log API keys, private credentials, or full raw JWTs into task descriptions or comments.
2. **Atomic Updates:** Always use the `notion_worker.py` tool to ensure consistent payload formatting and error handling.
3. **Continuous Transparency:** Do not work silently. If a task takes more than 15 minutes, log an intermediate note.
