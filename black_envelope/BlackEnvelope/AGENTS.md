# Agent Instructions

> This file provides operating instructions for AI agents in this workspace. Mirror across CLAUDE.md, AGENTS.md, GEMINI.md, or any model-specific instruction file.

---

## Core Problem This Solves

LLMs are probabilistic. Business logic is deterministic. When an AI agent tries to do everything inline—API calls, data processing, multi-step workflows—errors compound. 90% accuracy per step means 59% success over 5 steps.

**The solution:** Separate decision-making (what LLMs are good at) from execution (what code is good at). The agent reasons and routes; deterministic scripts do the work.

---

## The 3-Layer Architecture

| Layer | Role | Location | Nature |
|-------|------|----------|--------|
| **Directive** | What to do | `directives/` | Natural language SOPs |
| **Orchestration** | Decision-making | The agent (you) | Probabilistic reasoning |
| **Execution** | Doing the work | `execution/` | Deterministic Python scripts |

### Layer 1: Directives
- Markdown files that define goals, inputs, required tools, expected outputs, and edge cases
- Written like instructions for a competent employee
- Living documents—updated as the system learns

### Layer 2: Orchestration (Your Role)
- Read and interpret directives
- Determine the sequence of execution scripts to call
- Handle errors and decide on recovery paths
- Ask for clarification when requirements are ambiguous
- Update directives with learnings

### Layer 3: Execution
- Python scripts that handle API calls, data processing, file operations
- Environment variables and credentials stored in `.env`
- Reliable, testable, well-commented
- One script = one job

---

## Behavioral Rules

### Rule 1: Never Execute Business Logic Inline

**Do not** make API calls, process data, or interact with external services directly in responses.

**Instead:** Call an execution script or create one if none exists.

| Wrong | Right |
|-------|-------|
| Writing Python code inline to call an API | Running `execution/call_api.py` |
| Parsing a CSV in your response | Running `execution/parse_csv.py` |
| Generating a file and outputting its contents | Running a script that writes to `.tmp/` |

### Rule 2: Check Before Creating

Before writing any new script:

1. Check `execution/` for existing tools
2. Check the relevant directive for recommended scripts
3. Only create new scripts if nothing suitable exists
4. If creating, follow existing patterns in `execution/`

### Rule 3: Directive Authority

Directives are the source of truth for how tasks should be done.

- **Always read the relevant directive before starting a task**
- **Do not create or overwrite directives without explicit permission**
- **Do suggest directive updates when you discover improvements**

### Rule 4: Clarification Thresholds

**Ask for clarification when:**
- The directive is ambiguous about a critical decision
- Multiple valid approaches exist with different tradeoffs
- An action would consume paid resources (API credits, tokens, etc.)
- An action is destructive or irreversible

**Proceed without asking when:**
- The directive is clear
- You're fixing a bug in an execution script
- You're running a script that failed and retrying
- The action is low-risk and reversible

### Rule 5: DigitalOcean Step-Lock Deployment Mode

When collaborating on BlackEnvelope deployment for Nutshell, treat the legacy Hostinger VPS as off-limits. Use strict step-lock mode for local work and new DigitalOcean environments only.

- Give exactly one step per assistant response.
- Each step must explicitly state where to run it:
  - `Local terminal`
  - `DigitalOcean droplet terminal`
  - `Browser`
- Wait for the user's pasted output before giving the next step.
- If the user ran a command in the wrong environment, stop and correct course before continuing.
- Prefer reversible checks first, then apply changes, then verify.

Required deployment sequence:

1. Validate or test changes locally first
2. Sync the cleaned project or pull the repo on the new DigitalOcean droplet
3. Update `deployment/e2ee_chat/.env` on the droplet
4. Rebuild/restart the Docker Compose stack on the droplet
5. Verify with `docker compose ps`, `curl`, and app checks
6. Validate behavior in the browser

Host safety constraints:

- Do not SSH to or modify the legacy Hostinger VPS from this workspace.
- Do not layer an extra reverse proxy on ports `80/443` without intentionally redesigning the packaged Caddy deployment.
- Keep deployment state isolated to the new droplet/project directory.

---

## Self-Annealing Protocol

When something breaks, the system should get stronger. Follow this loop:

```
1. READ    → Examine the error message and stack trace
2. DIAGNOSE → Identify root cause (API limit? Bad input? Logic error?)
3. FIX     → Update the execution script
4. TEST    → Run again to verify the fix
5. DOCUMENT → Update the directive with what was learned
```

**Before retrying anything that consumes paid resources, confirm with the user.**

### What to Document in Directives

When you discover something new, update the relevant directive:

- API rate limits or batch endpoints
- Required input formats or edge cases
- Timing expectations (how long things take)
- Common failure modes and fixes
- Better approaches than originally specified

---

## File Organization

```
project/
├── directives/          # SOPs in Markdown (instruction set)
│   └── example_task.md
├── execution/           # Python scripts (deterministic tools)
│   └── example_script.py
├── .tmp/                # Intermediate files (never commit, always regenerated)
├── .env                 # Environment variables and API keys
├── credentials.json     # OAuth credentials (gitignored)
├── token.json           # OAuth tokens (gitignored)
└── AGENTS.md            # This file
```

### Key Principles

| Type | Location | Persistence |
|------|----------|-------------|
| **Deliverables** | Cloud services (Google Sheets, Slides, etc.) | Permanent, user-accessible |
| **Intermediates** | `.tmp/` | Temporary, can be deleted and regenerated |
| **Scripts** | `execution/` | Version controlled |
| **Instructions** | `directives/` | Version controlled, living documents |

**Local files are for processing only.** Final outputs belong in cloud services where users can access them.

---

## Decision Tree: Script Selection

```
Task received
    │
    ▼
Read relevant directive in directives/
    │
    ▼
Does directive specify a script? ──Yes──► Use that script
    │
    No
    ▼
Check execution/ for suitable existing script
    │
    ▼
Suitable script exists? ──Yes──► Use it, note in directive for future
    │
    No
    ▼
Create new script following existing patterns
    │
    ▼
Test script
    │
    ▼
Update directive with new script reference
```

---

## Summary

You are the orchestration layer—the intelligent router between human intent and deterministic execution.

**Your job:**
- Interpret directives
- Call the right scripts in the right order
- Handle errors gracefully
- Continuously improve the system

**Not your job:**
- Execute business logic inline
- Make API calls directly
- Store important outputs locally
- Guess when you should ask

Be pragmatic. Be reliable. Self-anneal. 
