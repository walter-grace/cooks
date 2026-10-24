# Search

One search box over everything in a workspace: prospects, accounts, calls and their transcript lines, buying signals, emails, notes, tasks and sequences. It runs on the same Postgres as the rest of Cooks and needs no model.

## Where it shows up

- **Web app.** Press ⌘K (Ctrl+K on Windows and Linux) or click **Search** at the top of the sidebar. Results update as you type, arrow keys move, Enter opens the record. Matched words are highlighted in the snippet. A transcript hit opens the call page at that line's timestamp.
- **API.** `GET /v1/search?q=…` with optional `types`, `limit`, `prospectId` and `accountId`. Scope `prospects:read`. Each hit carries `type`, `title`, `snippet` (matches wrapped in « »), `prospectId`, `accountId`, `occurredAt`, `meta` and `href`, the path inside the web app.
- **MCP.** The `cooks_search` tool takes the same arguments, so an assistant can find "the call where she asked about seats" before drafting the follow-up, or every mention of a competitor across calls and emails.

Query syntax is Postgres `websearch_to_tsquery`: plain words are ANDed, `"a quoted phrase"` must appear in order, `-word` excludes, `or` separates alternatives.

```sh
curl -s "$COOKS_API_URL/v1/search?q=renewal+pricing&types=transcript,email" -H "Authorization: Bearer $COOKS_API_KEY"
```

## How it works

A `search_index` table holds one row per record, or per transcript line, with `title`, `body`, the parent `prospect_id` and `account_id`, `occurred_at` and a generated `tsvector` (title weighted above body) under a GIN index.

Ranking: a title that starts with the query first, then full-text relevance (`ts_rank_cd`), then recency. A substring match on the title also counts, so part of a name or an email address hits without knowing how the stemmer cut the word.

The index is filled by the worker:

- `search.index_all` runs every two minutes and refreshes every workspace incrementally, reading rows whose `updated_at` is newer than the last indexed value for that type and dropping rows whose source was soft-deleted.
- `POST /v1/search/actions/reindex` (admins) queues a full rebuild for the workspace.
- The first search in a workspace with an empty index builds it inline, so a fresh install searches at once.

What is indexed per type:

| Type | Title | Body |
| --- | --- | --- |
| prospect | name or email | title, account, email, phone, location |
| account | name or domain | domain, industry, city, website, description |
| call | Call or Practice call, prospect | outcome, status, summary, notes |
| transcript | speaker, first words of the line | the line |
| signal | title or kind | kind, source, payload values |
| email | subject | to, from, body text |
| note | first words | the note |
| task | action, prospect | note |
| sequence | name | |

## Not yet

- Embeddings. The table has room for a vector column; a later phase can add pgvector embeddings from the workspace AI provider and merge them with the text ranking.
- Natural-language filters such as "CFOs at fintech accounts with a hiring signal". Those need a model to parse the query into filters.
- Web search. Research on a prospect or account stays with `cooks_research_prospect` and the weekly account scan.
