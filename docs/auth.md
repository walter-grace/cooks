# Signing in

Cooks has two sign-in modes for the web UI. API keys and OAuth 2.1 for MCP clients work the same in both.

| Mode | When | How users get in |
| --- | --- | --- |
| Password (default) | `CLERK_SECRET_KEY` is unset | `pnpm bootstrap --email … --password …` creates the first admin; admins add users through `/v1/users` |
| Clerk SSO | `CLERK_SECRET_KEY` is set | Anyone your Clerk instance admits (Google, Microsoft, email, SAML…) signs in at `/app/login`; Cooks creates the user on first visit |

`GET /auth/config` tells the UI which mode is active.

## Clerk SSO

1. Create an application at [clerk.com](https://clerk.com). Copy the publishable and secret keys.
2. Set in `.env`:

   ```bash
   CLERK_SECRET_KEY=sk_live_…
   CLERK_PUBLISHABLE_KEY=pk_live_…
   # optional: verify session tokens offline with the instance JWKS public key
   CLERK_JWT_KEY="-----BEGIN PUBLIC KEY-----…"
   # optional: slug of the workspace users land in when they have no Clerk organization
   COOKS_CLERK_DEFAULT_WORKSPACE=demo
   ```

3. Restart the API. The login page now renders Clerk's `<SignIn/>`. After sign-in the browser posts the Clerk session token to `POST /auth/clerk/session`; Cooks verifies it, upserts the user, and sets its own session cookie. Everything after that is identical to password mode.

### Organizations become workspaces

- A Clerk **organization** maps to a Cooks **workspace** (`workspaces.clerk_org_id`). The workspace slug is the organization slug; `org:admin` members become Cooks admins, everyone else is a `user`.
- A user with no active organization lands in `COOKS_CLERK_DEFAULT_WORKSPACE` if set, otherwise in a personal workspace (`u-<clerk id>`) where they are admin.
- Emails are matched case-insensitively, so an existing password user who signs in through Clerk with the same email is linked, not duplicated.

### Connecting apps through Clerk

Once a user has signed in through Clerk, Cooks can use the OAuth tokens Clerk already holds for them. No Google, Microsoft or HubSpot OAuth app of your own is needed. In Clerk enable the provider under **User & Authentication → Social connections**, use custom credentials, and add these scopes:

| Provider | Scopes | What it unlocks |
| --- | --- | --- |
| Google | `https://www.googleapis.com/auth/gmail.send` `https://www.googleapis.com/auth/gmail.readonly` | Settings → Mailboxes → **Connect Gmail via Clerk** |
| Microsoft | `Mail.Send` `Mail.Read` `offline_access` | Settings → Mailboxes → **Connect Microsoft 365 via Clerk** |
| HubSpot | `crm.objects.contacts.read` `crm.objects.contacts.write` `crm.objects.companies.read` `crm.objects.companies.write` `crm.objects.deals.read` `crm.objects.owners.read` `crm.lists.read` | Settings → CRM → **Connect HubSpot via Clerk** (admins) |

The buttons call `POST /v1/mailboxes/from-clerk` and `PUT /v1/workspace/crm/hubspot/from-clerk`. Cooks stores a marker, not the token: every send, sync and poll asks Clerk for a fresh access token for that user, so revoking the connection in Clerk revokes it in Cooks.

If a user has not linked the provider in Clerk yet, the button fails with a message telling them to add it to their Clerk profile first.

## Password mode

- `POST /auth/login` with `{email, password}` (JSON or form) sets the session cookie.
- `POST /auth/session-token` exchanges the cookie for a one-hour bearer token the UI uses against `/v1`.
- Mailboxes connect through Cooks' own OAuth apps (`GOOGLE_CLIENT_ID`, `MS_CLIENT_ID`, `HUBSPOT_CLIENT_ID`) or with SMTP/IMAP URLs and HubSpot private-app tokens.

## API keys and MCP

Unchanged by the mode: `cooks-api-…` keys (Settings → API keys & MCP) authenticate bots and integrations; OAuth 2.1 with PKCE and dynamic client registration serves remote MCP clients. In Clerk mode the consent flow sends people to `/app/login`, so a connector added in Claude or Grok signs in through Clerk and never needs a Cooks password. See `docs/mcp.md`.
