# Hosted AI in Cooks

Two ways to put a model to work. They are independent and you can use both.

## 1. Bring your own assistant (default, zero Cooks token spend)

Connect Claude, Grok, Cursor or any MCP client to the Cooks MCP server (`docs/mcp.md`). Your assistant is the brain: it searches prospects, builds sequences, works the task queue, drafts emails for you to approve. Cooks never calls a model on your behalf in this mode.

## 3. The in-app assistant

Press ⌘J (Ctrl+J) or click **Assistant** in the sidebar. It runs on the workspace's model provider from section 2 and uses the same tool catalog as the MCP server, executed as you: your role, your scopes, the workspace rate limits. Ask it things ("who clicked a link this week", "find the call where someone asked about seats") or tell it what to do ("enroll Ada in Q4 outbound"). It shows each step as it works, and when an answer is a record or a page it opens it.

Anything that sends, dials, deletes, enrolls or changes settings is only called when your latest message asks for exactly that; otherwise it says what it would do and asks you to confirm. Under the hood it is `POST /v1/chat` (scope `agents:run`), a server-sent event stream of `thinking`, `tool_call`, `tool_result`, `reply` and `done`. Each step is one structured-output call, so every provider in section 2 works, including a local model.

## 2. Hosted agents (Cooks calls a model for you)

Configure a provider for the workspace, then mark sequence steps with `aiEmail`. The worker drafts emails and classifies replies with structured, schema-validated calls, records every run with tokens and cost, and routes anything uncertain to a human.

```bash
# Anthropic (default model claude-opus-5-5)
curl -X PATCH $COOKS/v1/workspace/ai -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"data":{"provider":"anthropic","apiKey":"sk-ant-...","monthlyBudgetUsd":50}}'

# Grok via xAI (OpenAI-compatible endpoint, default model grok-4.7)
curl -X PATCH $COOKS/v1/workspace/ai -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"data":{"provider":"xai","apiKey":"xai-...","draftModel":"grok-4.7","classifyModel":"grok-4.3"}}'

# Fully local with Ollama
curl -X PATCH $COOKS/v1/workspace/ai -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"data":{"provider":"ollama","baseUrl":"http://localhost:11434/v1","model":"llama3.3"}}'
```

Keys are encrypted with `COOKS_KEK` and never returned; `GET /v1/workspace/ai` shows `hasKey` and the last four characters. Without a workspace key, the server falls back to `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` or `OLLAMA_BASE_URL` from the environment. With none of those, hosted features are off and the BYO path keeps working.

### AI email steps

```bash
curl -X POST $COOKS/v1/sequenceSteps -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"data":{"sequence":{"id":"..."},"action":"manual_email","interval":1440,
       "aiEmail":{"promptOverride":"Reference their recent Series B and ask for 15 minutes about onboarding automation."}}}'
```

When the step comes due, Cooks creates the rep's task and queues `ai.draft_email`. The draft lands on the task (`task.draftEmailId`, a `draft` email row) for the rep to review and send. Drafts are never sent automatically from a manual step. The model receives only facts Cooks holds (prospect, account, owner, prior thread, the step note, the override) and must list every claim it makes in `usedFacts`.

A draft goes to **needs review** (task note says so, run status `needs_review`) when confidence is below the workspace threshold (default 0.75) or the model raised a risk flag (`unverified_claim`, `pricing`, `legal`, `pii`, `off_topic`, `competitor`).

Reply classification (`ai.classify_reply`) returns intent, sentiment, a suggested action and an optional draft reply. Only an `unsubscribe` at 0.9+ confidence may write to the suppression list; everything else creates a task for a human.

### Runs, cost and budget

- `GET /v1/agentRuns` lists every run with provider, model, tokens, cost and status. `GET /v1/agentRuns/{id}` adds the redacted input (emails and phone numbers masked) and logs.
- `GET /v1/agentRuns/stats?days=30` aggregates spend by day, provider, model and kind.
- `monthlyBudgetUsd` stops new hosted calls for the rest of the UTC month once reached; the affected task simply has no draft.
- Identical classification inputs are cached for 30 days; drafts are never cached.

### Providers

| Provider | Transport | Notes |
| --- | --- | --- |
| `anthropic` | `@anthropic-ai/sdk`, `beta.messages.parse` with `output_config.format` | Adaptive thinking (model default), `effort` low for classification / medium for drafts, prompt caching on the system prompt, server-side refusal fallbacks enabled |
| `xai` | `openai` SDK against `https://api.x.ai/v1` | `response_format: json_schema` strict |
| `openai`, `openrouter`, `ollama`, `custom` | `openai` SDK against the preset or `baseUrl` | OpenRouter reports cost per call; others use the built-in price table |

Add a provider by calling `registerProvider(id, factory)` from `@cooks/agent`.
