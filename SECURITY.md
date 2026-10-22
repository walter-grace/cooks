# Security

Cooks stores mailbox credentials, CRM and telephony tokens, LLM provider keys and webhook signing secrets on behalf of its users. We take reports about any of that seriously.

## Reporting

Please do not open a public issue for a vulnerability. Use GitHub's private vulnerability reporting on this repository ("Report a vulnerability" under the Security tab). Include steps to reproduce and the version or commit you tested. You will get an acknowledgement within a few days.

## Scope

In scope: anything in this repository, including the API, worker, MCP server, web app and Docker images. Of particular interest:

- Cross-workspace data access
- Secrets appearing in API responses, logs or error messages
- Webhook or Twilio signature verification bypasses
- OAuth 2.1 flow weaknesses (PKCE, refresh rotation, consent)
- Bypasses of suppression, do-not-call or send-cap enforcement

Out of scope: issues in third-party services Cooks connects to, and findings that require an already compromised `COOKS_KEK` or database.

## Hardening notes for operators

- Generate a fresh 32-byte `COOKS_KEK` per deployment and back it up separately from the database.
- Put the API behind TLS and set `COOKS_PUBLIC_URL` to the public origin. Twilio and webhook signatures are verified against it.
- Rotate workspace API keys from Settings → API keys. Keys are stored as SHA-256 hashes and cannot be recovered.
- Leave `COOKS_OAUTH_DCR` off unless you need dynamic client registration for hosted connectors.
