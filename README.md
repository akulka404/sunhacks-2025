# CrisisVerse v1.0

CrisisVerse is an AI-powered crisis simulation platform built for SunHacks 2025. Users describe any real-world emergency scenario in plain text, and the system uses **Google Gemini 2.5 Flash** to parse it into a structured plan of actors (responders), tasks, constraints, and objectives. A multi-agent simulation engine then runs the response in one of two modes—**Deterministic** or **Agentic**—showing how different allocation strategies affect outcomes like evacuation progress, hospital operations, and power restoration.

## Features

- **Natural-language scenario input** – Type any crisis (earthquake, wildfire, power outage, mass casualty event, etc.) and Gemini structures it automatically.
- **Two simulation modes**
  - *Deterministic* – Rule-based assignment; tasks are matched to actors by capability. Overloaded actors block tasks.
  - *Agentic* – AI-driven; flexible override actors absorb excess demand, retry blocked tasks, and adapt in real time.
- **Multi-actor coordination** – Hospitals, power utilities, evacuation teams, shelters, traffic management, logistics, communications, and generalist responders all interact simultaneously.
- **Constraint enforcement** – Time deadlines, resource inventories, and policy blocks can be toggled in configuration.
- **Load-balancing demonstration** – A built-in preset scenario with constrained specialist teams makes the difference between modes immediately visible.
- **Real-time visualization** – The simulation page streams assignment steps (think → act → insight → execute → complete/blocked) as an animated event log.
- **Configurable engine** – Category weights, skill mappings, agent templates, throttle settings, and injected tasks are all driven by `src/config/simulation.json`.

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | [Next.js 14](https://nextjs.org) (App Router) |
| Language | TypeScript 5 |
| AI / LLM | Google Gemini 2.5 Flash (`@google/generative-ai`) |
| UI | React 18 |
| Testing | [Vitest](https://vitest.dev) |
| Linting | ESLint (Next.js config) |

## Project Structure

```
sunhacks-2025/
├── src/
│   ├── app/
│   │   ├── page.tsx                  # Home – scenario input form
│   │   ├── layout.tsx                # Root layout & metadata
│   │   ├── globals.css               # Global styles
│   │   ├── simulation/
│   │   │   └── page.tsx              # Simulation viewer (event log, metrics)
│   │   └── api/
│   │       ├── simulate/route.ts     # POST /api/simulate – parse scenario → structured plan
│   │       └── agent/decide/         # POST /api/agent/decide – per-actor LLM decision
│   ├── config/
│   │   └── simulation.json           # Engine configuration (weights, skills, templates, presets)
│   └── lib/
│       ├── gemini.ts                 # Gemini client + callGemini helper
│       ├── agents.ts                 # Agent prompt builder + LLM caller
│       ├── simulator.ts              # Core assignment engine (buildAssignmentSteps)
│       └── openai.ts                 # OpenAI client stub (unused in v1.0)
├── tests/
│   ├── simulator.test.ts             # Unit tests for assignment engine
│   └── agentic_differentiation.test.ts  # Tests proving agentic mode outperforms deterministic
├── .env.example                      # Environment variable template
├── next.config.mjs
├── tsconfig.json
└── vitest.config.ts
```

## How It Works

1. **Scenario parsing** – The home page POSTs the user's prompt to `/api/simulate`. Gemini transforms it into a JSON plan containing actors, tasks, constraints, and objectives.
2. **Plan storage** – The structured plan is stored in `sessionStorage` and the browser navigates to `/simulation`.
3. **Assignment engine** – `buildAssignmentSteps` in `src/lib/simulator.ts` iterates over tasks in priority order (demand × category weight × urgency), assigns them to eligible actors, and emits typed step events.
4. **Agentic overrides** – In agentic mode, actors flagged `agentic_override: true` (e.g., adaptive responders, cross-trained specialists) can absorb tasks that specialist teams cannot handle due to capacity or skill gaps.
5. **Simulation playback** – The simulation page replays the step stream with configurable inter-step delays, building a live event log alongside cumulative metrics.

## Prerequisites

- **Node.js** ≥ 18
- A **Google Gemini API key** (free tier available at [Google AI Studio](https://aistudio.google.com/app/apikey))

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env.local
#    Then open .env.local and set GEMINI_API_KEY=<your-key>

# 3. Start the development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser, type a crisis scenario, and click **start simulation**.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | ✅ Yes | Google Gemini API key used by `src/lib/gemini.ts` |
| `NEXT_TELEMETRY_DISABLED` | No | Set to `1` to disable Next.js telemetry |

Copy `.env.example` to `.env.local` and fill in the values.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the Next.js development server (hot reload) |
| `npm run build` | Compile and optimize for production |
| `npm run start` | Serve the production build |
| `npm run lint` | Run ESLint across the project |
| `npx vitest` | Run unit tests with Vitest |

## Simulation Modes

### Deterministic
Actors are matched to tasks strictly by capability. If all capable actors are at capacity the task is **blocked**. No fallback occurs. This mode reveals capacity bottlenecks clearly.

### Agentic
After the standard capability match, the engine checks for `agentic_override` actors (generalists and cross-trained specialists). These actors:
- Are assigned to tasks that have no eligible specialist.
- Step in when the best specialist is near capacity.
- Retry all blocked tasks in a second pass.

The net result is significantly more tasks completed and higher objective scores compared to deterministic mode under the same scenario.

## Configuration

`src/config/simulation.json` controls the engine without code changes:

- **`llm`** – Gemini temperature and top-p for scenario parsing and agent decisions.
- **`constraints`** – Toggle time-limit, resource-limit, and policy-limit enforcement.
- **`categoryWeights`** – Priority multipliers per task category.
- **`categorySkills`** – Required skills for each task category.
- **`agentTemplates`** – Action and insight message templates per category.
- **`phases`** – Execution progress checkpoints (e.g., `[0.25, 0.5, 0.75, 1.0]`).
- **`throttle`** – Override capacity per round and inter-step timing.
- **`injectedTasks`** – Additional tasks always appended to every simulation.
- **`demoPresets`** – Pre-built actor/task sets (e.g., `loadBalancingDemo`) for consistent demonstrations.

## Testing

Unit tests live in the `tests/` directory and use [Vitest](https://vitest.dev).

```bash
npx vitest
```

Key test files:
- `simulator.test.ts` – Covers core assignment logic (capacity, skills, deadlines, resource and policy constraints).
- `agentic_differentiation.test.ts` – Verifies that agentic mode completes more tasks than deterministic mode under constrained conditions.

## License

[MIT](LICENSE)
