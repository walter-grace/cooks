// Minimal HubSpot stand-in for QA: contacts, companies, owners, lists, deals, engagement writes.
import { createServer } from 'node:http';
const port = Number(process.env.PORT ?? 18090);
const contacts = {
  '101': { firstname: 'Ada', lastname: 'Lovelace', email: 'ada@globex.example', jobtitle: 'VP Engineering', hubspot_owner_id: '7', associatedcompanyid: '900', hs_timezone: 'America/New_York' },
  '102': { firstname: 'Grace', lastname: 'Hopper', email: 'grace@globex.example', jobtitle: 'Director of Operations', hubspot_owner_id: '7', associatedcompanyid: '900' },
  '104': { firstname: 'Linus', lastname: 'Torvalds', email: 'linus@kernel.example', jobtitle: 'Fellow', hubspot_owner_id: '7', associatedcompanyid: '901' },
};
const companies = { '900': { name: 'Globex Corporation', domain: 'globex.example', industry: 'Manufacturing', numberofemployees: '1200' }, '901': { name: 'Kernel Labs', domain: 'kernel.example', industry: 'Software' } };
const writes = [];
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
createServer(async (req, res) => {
  const auth = req.headers.authorization ?? '';
  if (!auth.endsWith('qa-token')) return json(res, 401, { status: 'error', message: 'invalid token' });
  let body = '';
  for await (const c of req) body += c;
  const b = body ? JSON.parse(body) : undefined;
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  if (p === '/account-info/v3/details') return json(res, 200, { portalId: 777001 });
  if (p === '/crm/v3/owners') return json(res, 200, { results: [{ id: '7', email: process.env.OWNER_EMAIL ?? 'demo@cooks.local' }] });
  if (p === '/crm/v3/objects/contacts/batch/read') {
    const byEmail = b.idProperty === 'email';
    const results = b.inputs.map(({ id }) => (byEmail ? Object.entries(contacts).find(([, c]) => c.email.toLowerCase() === id.toLowerCase()) : contacts[id] ? [id, contacts[id]] : undefined)).filter(Boolean).map(([id, properties]) => ({ id, properties }));
    return json(res, 200, { results });
  }
  if (p === '/crm/v3/objects/companies/batch/read') return json(res, 200, { results: b.inputs.filter((i) => companies[i.id]).map((i) => ({ id: i.id, properties: companies[i.id] })) });
  if (p.startsWith('/crm/v3/lists/') && p.endsWith('/memberships')) return json(res, 200, { results: [{ recordId: '101' }, { recordId: '102' }] });
  if (p === '/crm/v3/objects/deals/search') return json(res, 200, { results: [{ id: 'd1' }] });
  if (p === '/crm/v4/objects/deals/d1/associations/contacts') return json(res, 200, { results: [{ toObjectId: 104 }] });
  if (['/crm/v3/objects/notes', '/crm/v3/objects/emails', '/crm/v3/objects/calls'].includes(p)) { writes.push({ p, b }); return json(res, 201, { id: `w${writes.length}` }); }
  if (p === '/__writes') return json(res, 200, writes);
  return json(res, 404, { message: `unhandled ${p}` });
}).listen(port, '127.0.0.1', () => console.log(`mock hubspot on :${port}`));
