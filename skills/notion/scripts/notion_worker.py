#!/usr/bin/env python3
"""
notion_worker.py - CLI helper for Submind agents interacting with The Submind Notion Board.
"""
import os
import sys
import json
import argparse
import urllib.request
import urllib.error
import ssl

TOKEN = os.environ.get("NOTION_API_KEY") or os.environ.get("NOTION_TOKEN") or "ntn_z27608992969p2QDQcAvNeKG395NNRqlha6eOWFsD8MbyL"
DB_ID = os.environ.get("NOTION_DATABASE_ID") or "3d80a48f-fae0-816b-bc00-e4cba96c85aa"

HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json"
}

def get_ssl_context():
    try:
        return ssl._create_unverified_context()
    except Exception:
        return ssl.create_default_context()

def request_notion(endpoint, data=None, method="GET"):
    url = f"https://api.notion.com/v1/{endpoint.lstrip('/')}"
    body = json.dumps(data).encode("utf-8") if data else None
    req = urllib.request.Request(url, data=body, headers=HEADERS, method=method)
    try:
        ctx = get_ssl_context()
        with urllib.request.urlopen(req, context=ctx) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8")
        print(f"Error {e.code}: {err}", file=sys.stderr)
        sys.exit(1)

def cmd_list(args):
    payload = {"page_size": args.limit}
    filters = []
    if args.agent:
        filters.append({"property": "Agent", "select": {"equals": args.agent.capitalize()}})
    if args.status:
        filters.append({"property": "Status", "status": {"equals": args.status}})
    
    if len(filters) == 1:
        payload["filter"] = filters[0]
    elif len(filters) > 1:
        payload["filter"] = {"and": filters}

    res = request_notion(f"databases/{DB_ID}/query", data=payload, method="POST")
    pages = res.get("results", [])
    
    out = []
    for p in pages:
        props = p.get("properties") or {}
        title_list = (props.get("Task") or {}).get("title", [])
        title = title_list[0].get("plain_text", "Untitled") if title_list else "Untitled"
        status = ((props.get("Status") or {}).get("status") or {}).get("name", "Unknown")
        agent_sel = (props.get("Agent") or {}).get("select")
        agent = agent_sel.get("name", "Unassigned") if agent_sel else "Unassigned"
        prio_sel = (props.get("Priority") or {}).get("select")
        priority = prio_sel.get("name", "Normal") if prio_sel else "Normal"
        domain_sel = (props.get("Domain") or {}).get("select")
        domain = domain_sel.get("name", "General") if domain_sel else "General"
        url = (props.get("Target URL") or {}).get("url") or ""
        
        out.append({
            "id": p["id"],
            "title": title,
            "status": status,
            "agent": agent,
            "priority": priority,
            "domain": domain,
            "url": url
        })

    if args.json:
        print(json.dumps(out, indent=2))
    else:
        if not out:
            print("No tasks found matching query.")
            return
        print(f"{'ID':<38} | {'STATUS':<12} | {'AGENT':<10} | {'TASK'}")
        print("-" * 80)
        for t in out:
            print(f"{t['id']} | {t['status']:<12} | {t['agent']:<10} | {t['title']}")

def cmd_create(args):
    payload = {
        "parent": {"database_id": DB_ID},
        "properties": {
            "Task": {"title": [{"text": {"content": args.title}}]},
            "Status": {"status": {"name": args.status}},
            "Agent": {"select": {"name": args.agent.capitalize()}},
            "Priority": {"select": {"name": args.priority.capitalize()}},
        }
    }
    if args.domain:
        payload["properties"]["Domain"] = {"select": {"name": args.domain}}
    if args.url:
        payload["properties"]["Target URL"] = {"url": args.url}
    if args.notes:
        payload["properties"]["Notes"] = {"rich_text": [{"text": {"content": args.notes}}]}

    res = request_notion("pages", data=payload, method="POST")
    print(f"Created task '{args.title}' with ID: {res['id']}")

def cmd_update(args):
    payload = {"properties": {}}
    if args.status:
        payload["properties"]["Status"] = {"status": {"name": args.status}}
    if args.notes:
        payload["properties"]["Notes"] = {"rich_text": [{"text": {"content": args.notes}}]}
    if args.url:
        payload["properties"]["Target URL"] = {"url": args.url}

    clean_id = args.task_id.replace("-", "")
    res = request_notion(f"pages/{clean_id}", data=payload, method="PATCH")
    print(f"Updated task {args.task_id} successfully.")

def cmd_complete(args):
    payload = {
        "properties": {
            "Status": {"status": {"name": "Done"}}
        }
    }
    if args.url:
        payload["properties"]["Target URL"] = {"url": args.url}
    if args.summary:
        payload["properties"]["Notes"] = {"rich_text": [{"text": {"content": args.summary}}]}

    clean_id = args.task_id.replace("-", "")
    res = request_notion(f"pages/{clean_id}", data=payload, method="PATCH")
    print(f"Completed task {args.task_id} -> Status: Done.")

def main():
    parser = argparse.ArgumentParser(description="Submind Notion Worker CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    # list
    p_list = sub.add_parser("list")
    p_list.add_argument("--agent", help="Filter by agent name")
    p_list.add_argument("--status", help="Filter by status (Backlog, In Progress, Blocked, Done)")
    p_list.add_argument("--limit", type=int, default=20)
    p_list.add_argument("--json", action="store_true", help="Output raw JSON")
    p_list.set_defaults(func=cmd_list)

    # create
    p_create = sub.add_parser("create")
    p_create.add_argument("--title", required=True, help="Task title")
    p_create.add_argument("--agent", required=True, help="Assigned agent")
    p_create.add_argument("--status", default="Backlog", help="Initial status")
    p_create.add_argument("--priority", default="Normal", help="Priority (Urgent, High, Normal, Low)")
    p_create.add_argument("--domain", help="Business domain")
    p_create.add_argument("--url", help="Target URL / PR")
    p_create.add_argument("--notes", help="Initial notes")
    p_create.set_defaults(func=cmd_create)

    # update
    p_update = sub.add_parser("update")
    p_update.add_argument("task_id", help="Notion task page ID")
    p_update.add_argument("--status", help="New status")
    p_update.add_argument("--notes", help="Update notes text")
    p_update.add_argument("--url", help="Update target URL")
    p_update.set_defaults(func=cmd_update)

    # complete
    p_comp = sub.add_parser("complete")
    p_comp.add_argument("task_id", help="Notion task page ID")
    p_comp.add_argument("--summary", help="Completion summary")
    p_comp.add_argument("--url", help="Deliverable or PR URL")
    p_comp.set_defaults(func=cmd_complete)

    args = parser.parse_args()
    args.func(args)

if __name__ == "__main__":
    main()
