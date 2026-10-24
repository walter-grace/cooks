# context.dev, and what a Cooks search feature would look like

Researched 2026-10-23 from public pages. Every claim carries its source; items marked *unverified* came from third-party write-ups or search snippets that were not opened. Nothing from the site is vendored.

## What context.dev is

- A hosted web-data API for software and AI agents. The tagline is "The unified web context API for software and AI agents." One key covers scraping, crawling, web search, structured extraction, brand data, people and company enrichment, news and monitoring. Source: https://www.context.dev/
- It is a data API, not an in-app search product, a browser or a docs-search tool. There is no end-user search UI to copy; the thing to borrow is the shape of the API and the idea that search, enrichment and research sit behind one key.
- Pricing (https://context.dev/pricing): Free $0 with 1,000 credits and 2 concurrent requests; Developer $19 for 7,500 credits; Pro $99 for 125,000; Growth $299 for 500,000; Scale $499 for 1M; Enterprise custom. Overage $1.00 to $2.20 per 1K credits. JS rendering and proxies are included in the scrape price.
- History and funding, *unverified*: formerly Brand.dev, renamed March 21; $9M led by General Catalyst; founder Yahia Bakour; YC S26; launch date reported as either July 2 (Product Hunt) or August 5, 2026. Sources: https://runtimewire.com/article/context-dev-raises-9m-web-data-api and https://www.runtimewire.com/article/context-dev-yahia-bakour-yc-s26-web-data-api. Customer names in one write-up (Mintlify, Klarna, Chatwoot) are unverified.
- GitHub: https://github.com/context-dot-dev has 27 repos. The TypeScript, Python, Ruby, Go and PHP SDKs and the CLI are Apache-2.0; `sgrep` and `webdog` are MIT.
- Not found: a Hacker News thread, a blog or changelog linked from the homepage.

## The search feature

- Searches the live web, not private data (https://docs.context.dev/llms.txt). Web search returns ranked results and can return page content or relevant passages. News search takes a natural-language query or a company by name, domain, ticker or ISIN, with filters and cursor paging. Company search and people search take natural-language queries. Brand autocomplete returns up to ten brands by popularity. The homepage also lists domain and freshness filters and an Answers endpoint that returns JSON in a shape you specify, with sources.
- REST under `/v1` with an OpenAPI spec; responses carry `key_metadata` with `credits_consumed` and `credits_remaining` (https://docs.context.dev/api-reference). Request and response shapes for the search endpoints were not read; only the scrape endpoint was.
- Ranking, latency and limits: not disclosed in anything read.
- MCP server at `https://mcp.context.dev/mcp`, OAuth with PKCE or an API key header, exposing scrape, crawl, search, brand, batch and monitor tools (https://docs.context.dev/install-mcp).
- The one disclosed search design is `sgrep` (https://github.com/context-dot-dev/sgrep, MIT): hybrid search with BM25 plus 256-dimension static embeddings and no transformer at query time; top 200 from each side, scored 75% semantic and 25% BM25; exact identifier matches rank first. A design reference, not their hosted search.

## Tech stack

Not disclosed. No job posts, architecture posts or docs name a vector store, embedding model or search engine for the hosted product. The org's repos are mostly TypeScript, Python and Go.

## Building blocks Cooks could use

Cooks runs on one Postgres by design, so the first choice is whatever needs no second service. Licenses below are from memory and should be checked before adoption.

| Option | License | Hybrid search | Fit |
| --- | --- | --- | --- |
| Postgres `tsvector` + GIN | PostgreSQL | Keyword only, `ts_rank` | First step, zero new moving parts |
| `pg_trgm` | PostgreSQL (contrib) | Fuzzy names and emails | Pairs with the above |
| `pgvector` | PostgreSQL | Vector; merge with tsvector by Reciprocal Rank Fusion in SQL | Second step, still one database |
| Meilisearch | MIT (community) | Built in | Good, but a separate service |
| Typesense | GPL-3.0 | Built in | Ideas only, never vendor |
| Orama | Apache-2.0 | Built in, in-process JS | Small client-side indexes, not durable |
| Elastic / OpenSearch | Varies by version | Built in | A second datastore, not recommended here |

`sgrep`'s 75/25 semantic-to-BM25 blend is a usable starting weight once embeddings exist.

## Proposal: Cooks search

### What exists today

- The Prospects page has a search box labelled "Exact name or email" that maps to `filter[primaryEmail]` or `filter[name]`: exact-match filtering on one table (`apps/web/src/pages/Prospects.tsx`).
- The MCP server has a "List or search prospects" tool (`apps/mcp/src/tools.ts`), `cooks_research_prospect` for web-grounded research on one prospect, and the signals feed with kind and status filters.
- There is no full-text or semantic search, no cross-entity search and no command palette. `packages/db` has no `tsvector`, `pg_trgm`, `vector` or `CREATE EXTENSION` anywhere.
- Searchable text already stored: `call_transcripts.text`, `summary` and `segments`; `signals.title` and `payload`; emails, notes, prospects, accounts, tasks and sequences.

### What a rep types, and what comes back

Queries like "pricing objection Acme", "who mentioned the Salesforce renewal", "emails where they asked for a demo" or "CFOs at fintech accounts with a hiring signal". Version one handles keyword and fuzzy queries; the last example needs a later step that parses filters out of natural language with the workspace AI provider.

Results are mixed and typed, each with a snippet, a highlight and a deep link: prospects, accounts, calls with the matching transcript line and its timestamp, signals, emails, notes, and optionally the repo docs.

### How it is exposed

- REST: `GET /v1/search?q=&types=&limit=`, following the `/v1` conventions, tagged as a Cooks extension.
- MCP: one tool, `cooks_search`, returning the same results so an assistant can find "the call where she asked about seats" before drafting the follow-up.
- Web: a command palette on Cmd-K that calls the endpoint and jumps to the record.
- Every query is scoped by `workspace_id`, like the rest of the schema.

### Schema for version one

One table, `search_index`: `id`, `workspace_id`, `entity_type`, `entity_id`, `parent_prospect_id`, `parent_account_id`, `title`, `body`, `tsv` (generated `tsvector`, GIN index), `occurred_at`, and a nullable `embedding vector(…)` reserved for version two. A `pg_trgm` index on `title` for typo tolerance; a unique index on (`workspace_id`, `entity_type`, `entity_id`). Rows are written by the worker from the existing outbox events (whether the outbox already covers every entity type was not verified). Transcripts are chunked per segment or per roughly 2 KB.

### Phases

1. `tsvector` plus `pg_trgm`, the REST endpoint, the MCP tool and the palette.
2. `pgvector` embeddings from the workspace AI provider, merged with Reciprocal Rank Fusion.
3. Natural-language filters parsed by the model.

### Optional bridge to context.dev

context.dev, or any web-search provider, could be an optional source behind `cooks_research_prospect` and the weekly account scan, which today use the workspace AI provider through OpenRouter. That is an integration behind a key the workspace adds, not part of the core.
