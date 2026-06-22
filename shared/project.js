// Active-project resolution + a tiny switcher, shared by both views. Project data
// lives in the server's home dir, so the app reaches it through /api/p/<project>/…
// (there is no static content/ anymore — the server is required).

export async function resolveProjects() {
  let info = { projects: [], current: null };
  try { const r = await fetch('/api/projects', { cache: 'no-store' }); if (r.ok) info = await r.json(); } catch { /* server down */ }
  const want = new URL(location.href).searchParams.get('p');
  // honor an explicit ?p= (and a server-reported current) whenever the list can't
  // contradict it — e.g. the server is briefly unreachable or still starting up.
  const active = (want && (info.projects.includes(want) || !info.projects.length)) ? want
    : (info.current && (info.projects.includes(info.current) || !info.projects.length)) ? info.current
    : info.projects[0] || info.current || 'default';
  return { projects: info.projects || [], current: info.current, active };
}

export const apiBase = (proj) => `/api/p/${encodeURIComponent(proj)}`;

// put the active project in the browser tab title so it's obvious which one you're in
export function setTabTitle(proj, view) {
  document.title = proj ? `${proj} · ${view} · Workflow Atlas` : `${view} · Workflow Atlas`;
}

// preserve ?p=<project> when linking between views / storyboards
export function withProject(href, proj) {
  const u = new URL(href, location.href);
  if (proj) u.searchParams.set('p', proj);
  return u.pathname + u.search + u.hash;
}

// dropdown switcher into `host`; changing it reloads the view for that project
export function renderSwitcher(host, info) {
  if (!host) return;
  host.innerHTML = '';
  const sel = document.createElement('select');
  sel.className = 'proj-switch';
  sel.setAttribute('aria-label', 'Project');
  const opts = info.projects.length ? info.projects : (info.active ? [info.active] : []);
  for (const p of opts) {
    const o = document.createElement('option');
    o.value = p; o.textContent = p; if (p === info.active) o.selected = true;
    sel.appendChild(o);
  }
  if (!opts.length) { const o = document.createElement('option'); o.textContent = '(no project)'; sel.appendChild(o); sel.disabled = true; }
  sel.addEventListener('change', () => {
    const u = new URL(location.href);
    u.searchParams.set('p', sel.value);
    u.hash = '';
    location.href = u.pathname + u.search;
  });
  host.appendChild(sel);
}

// rewrite the Workflows/Algorithms switch links so they carry the active project
export function wireSwitchLinks(proj) {
  document.querySelectorAll('.switch a').forEach((a) => {
    const href = a.getAttribute('href');
    if (href) a.setAttribute('href', withProject(href, proj));
  });
}
