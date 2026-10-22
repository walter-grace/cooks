const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const shell = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Cooks</title>
<style>:root{color-scheme:light dark}body{font-family:system-ui,sans-serif;max-width:28rem;margin:6vh auto;padding:0 1rem;line-height:1.5}form{display:grid;gap:.75rem}input,button{font:inherit;padding:.6rem .75rem;border-radius:.5rem;border:1px solid #8884}button{cursor:pointer;background:#111;color:#fff}button.secondary{background:transparent;color:inherit}.err{color:#b00020}ul{padding-left:1.2rem}code{font-size:.9em}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;

export function loginPage(next: string, error?: string) {
  return shell(
    'Sign in',
    `${error ? `<p class="err">${esc(error)}</p>` : ''}<form method="post" action="/auth/login"><input type="hidden" name="next" value="${esc(next)}"><label>Email<br><input name="email" type="email" required autofocus></label><label>Password<br><input name="password" type="password" required></label><button>Sign in</button></form>`,
  );
}

export function workspacePicker(options: Array<{ id: string; name: string }>, query: string) {
  const items = options.map((o) => `<li><a href="/oauth/authorize?${esc(query)}&workspace=${esc(o.id)}">${esc(o.name)}</a></li>`).join('');
  return shell('Choose a workspace', `<ul>${items}</ul>`);
}

export function consentPage(a: { clientName: string; scopes: Array<{ scope: string; description: string }>; workspaceName: string; userEmail: string; query: string }) {
  const list = a.scopes.map((s) => `<li><code>${esc(s.scope)}</code> · ${esc(s.description)}</li>`).join('');
  return shell(
    `Allow ${a.clientName}?`,
    `<p><strong>${esc(a.clientName)}</strong> wants access to <strong>${esc(a.workspaceName)}</strong> as ${esc(a.userEmail)}:</p><ul>${list}</ul>
<form method="post" action="/oauth/authorize/decision"><input type="hidden" name="q" value="${esc(a.query)}"><button name="decision" value="approve">Allow</button><button class="secondary" name="decision" value="deny">Deny</button></form>`,
  );
}

export function errorPage(title: string, message: string) {
  return shell(title, `<p class="err">${esc(message)}</p>`);
}
