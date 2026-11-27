// Grimalkin install wizard. Runs entirely in the browser: the page's Content
// Security Policy blocks every network request this script could make, secrets
// are generated with crypto.getRandomValues, and only non-secret answers are
// kept (in this browser's localStorage) so a reload doesn't lose your place.
'use strict'

const STORE = 'grimalkin-install-v1'
const PLACEHOLDER_SUBJECT = 'replace-after-first-sign-in'
const LOCAL_URL = 'http://localhost:8080'
const LOCAL_DB = 'postgres://postgres:grimalkin@localhost:5432/grimalkin'

const state = {
  where: 'railway', provider: 'google', gaccount: 'workspace',
  doneClone: false, publicUrl: '', googleClientId: '', googleClientSecret: '', mintOutput: '',
  githubClientId: '', githubClientSecret: '', githubLogin: '', githubUserId: '',
  oidcPreset: 'okta', oidcIssuer: '', oidcClientId: '', oidcClientSecret: '', oidcAuthMethod: '',
  oidcSubLater: false, oidcSub: '',
  self: '', emails: '', policy: '',
  step: 0,
}
const SECRET_KEYS = new Set(['googleClientSecret', 'mintOutput', 'githubClientSecret', 'oidcClientSecret'])
let authSecret = makeSecret()

const OIDC = {
  okta: { issuer: 'https://your-org.okta.com/oauth2/default', help: 'Your Okta domain plus /oauth2/default (or your custom authorization server). Use plain https://your-org.okta.com only if you have no custom one.', sub: 'For Okta it is your user ID, which starts with 00u.', name: 'Okta' },
  entra: { issuer: 'https://login.microsoftonline.com/<tenant-id>/v2.0', help: 'Use your tenant ID (Overview page in Entra), not "common" or "organizations".', sub: 'Entra gives each app a different one, so the refusal page is the easy way to find it.', name: 'Microsoft' },
  authentik: { issuer: 'https://auth.example.com/application/o/grimalkin/', help: 'Keep the slash at the end. Authentik shows the exact value on the provider\'s page as "OpenID Configuration Issuer".', sub: 'For Authentik it depends on the provider\'s Subject mode (a hashed user ID by default).', name: 'Authentik' },
  keycloak: { issuer: 'https://keycloak.example.com/realms/your-realm', help: 'Your Keycloak address plus /realms/ and the realm name.', sub: 'For Keycloak it is the user\'s ID in the admin console.', name: 'Keycloak' },
  other: { issuer: 'https://id.example.com', help: 'Exactly as the "issuer" line in <issuer>/.well-known/openid-configuration, including any slash at the end.', sub: 'Your provider may show it in your profile or the admin console.', name: '' },
}

// ── helpers ────────────────────────────────────────────────────────────────
const $ = (s, el = document) => el.querySelector(s)
const $$ = (s, el = document) => [...el.querySelectorAll(s)]

function makeSecret () {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)) // 44 characters
}

function load () {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || '{}')
    for (const k of Object.keys(state)) if (k in saved && !SECRET_KEYS.has(k)) state[k] = saved[k]
  } catch { /* storage blocked: start fresh */ }
}
function save () {
  try {
    const out = {}
    for (const k of Object.keys(state)) if (!SECRET_KEYS.has(k)) out[k] = state[k]
    localStorage.setItem(STORE, JSON.stringify(out))
  } catch { /* fine */ }
}

function normalizeUrl (raw) {
  let s = (raw || '').trim()
  if (!s) return { url: '', error: '' }
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s
  let u
  try { u = new URL(s) } catch { return { url: '', error: 'That doesn\'t look like a web address.' } }
  if (u.protocol !== 'https:') return { url: '', error: 'It must start with https://.' }
  if (u.pathname !== '/' || u.search || u.hash) return { url: '', error: 'Use only the address itself, with nothing after the domain (no /mcp or other path).' }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return { url: '', error: 'Use a domain name, not an IP address.' }
  return { url: `https://${u.host.toLowerCase()}`, error: '' }
}

const baseUrl = () => state.where === 'local' ? LOCAL_URL : normalizeUrl(state.publicUrl).url
const urlOr = (path = '') => (baseUrl() || 'https://<your-address>') + path

function mint () {
  const t = state.mintOutput.match(/GOOGLE_REFRESH_TOKEN_WORK=(\S+)/)
  const s = state.mintOutput.match(/ALLOWED_SUBJECT=(\S+)/)
  return { token: t ? t[1] : '', subject: s ? s[1] : '' }
}

function subject () {
  if (state.provider === 'google') return mint().subject
  if (state.provider === 'github') return state.githubUserId.trim()
  return state.oidcSubLater ? PLACEHOLDER_SUBJECT : state.oidcSub.trim()
}

// .env value quoting. Node's --env-file and Railway's raw editor both read
// quoted (and multi-line quoted) values; pick a quote the value doesn't contain.
function q (v) {
  if (v === '' || /^[A-Za-z0-9_./:@+=,${}-]+$/.test(v)) return v
  for (const c of ['"', "'", '`']) if (!v.includes(c)) return c + v + c
  return '"' + v.replace(/"/g, "'") + '"'
}
function env (pairs) {
  return pairs.filter(Boolean).map(([k, v]) => `${k}=${q(v ?? '')}`).join('\n')
}

function policyLines () {
  return state.policy.split(/\r?\n/).map(l => l.trim()).filter(Boolean).join('\n')
}
function ownerPairs () {
  const p = policyLines()
  return [
    ['PCL_SELF', state.self.trim()],
    ['PCL_SELF_EMAILS', state.emails.split(',').map(s => s.trim()).filter(Boolean).join(', ')],
    // The browser already knows the zone the owner lives in; most hosts run in UTC.
    ['PCL_TIMEZONE', Intl.DateTimeFormat().resolvedOptions().timeZone || ''],
    p && ['PCL_OPERATING_POLICY', p],
    p && ['PCL_OPERATING_POLICY_VERSION', new Date().toISOString().slice(0, 10)],
  ]
}
function signInPairs () {
  const pairs = [['AUTH_PROVIDER', state.provider], ['ALLOWED_SUBJECT', subject()]]
  if (state.provider === 'github') {
    pairs.push(['GITHUB_CLIENT_ID', state.githubClientId.trim()], ['GITHUB_CLIENT_SECRET', state.githubClientSecret.trim()])
  } else if (state.provider === 'oidc') {
    const name = OIDC[state.oidcPreset]?.name
    pairs.push(['OIDC_ISSUER', state.oidcIssuer.trim()], ['OIDC_CLIENT_ID', state.oidcClientId.trim()], ['OIDC_CLIENT_SECRET', state.oidcClientSecret.trim()])
    if (name) pairs.push(['OIDC_NAME', name])
    if (state.oidcAuthMethod) pairs.push(['OIDC_TOKEN_AUTH_METHOD', state.oidcAuthMethod])
  }
  return pairs
}
const googlePairs = () => [['GOOGLE_CLIENT_ID', state.googleClientId.trim()], ['GOOGLE_CLIENT_SECRET', state.googleClientSecret.trim()]]

function missing () {
  const m = []
  if (state.where === 'railway' && !baseUrl()) m.push('your Grimalkin address (step 3)')
  if (!state.googleClientId.trim() || !state.googleClientSecret.trim()) m.push('the Google client ID and secret (step 4)')
  if (!mint().token) m.push('the calendar token (step 5)')
  if (!subject()) m.push(state.provider === 'google' ? 'your Google account number (step 5)' : 'your user ID (sign-in step)')
  if (state.provider === 'github' && (!state.githubClientId.trim() || !state.githubClientSecret.trim())) m.push('the GitHub client ID and secret (sign-in step)')
  if (state.provider === 'oidc' && (!state.oidcIssuer.trim() || !state.oidcClientId.trim() || !state.oidcClientSecret.trim())) m.push('the issuer, client ID and secret (sign-in step)')
  if (!state.self.trim()) m.push('your name (step "About you")')
  return m
}

// ── templates ─────────────────────────────────────────────────────────────
const T = {
  cmdClone: () => 'corepack enable\ngit clone https://github.com/webfeathers/grimalkin.git\ncd grimalkin\npnpm install',
  scopes: () => 'https://www.googleapis.com/auth/calendar.readonly\nhttps://www.googleapis.com/auth/contacts.readonly',
  googleRedirects: () => ['http://localhost:4711/callback', state.provider === 'google' && urlOr('/oauth/google/callback')].filter(Boolean).join('\n'),
  starterEnv: () => env([...googlePairs(), ['AUTH_PROVIDER', state.provider]]),
  cmdMint: () => 'pnpm mint:google work',
  githubUrls: () => `Homepage URL:                ${urlOr()}\nAuthorization callback URL:  ${urlOr('/oauth/github/callback')}`,
  oidcRedirect: () => urlOr('/oauth/oidc/callback'),
  railwayMcp: () => env([
    ['PCL_ROLE', 'mcp'], ['NODE_ENV', 'production'], ['DATABASE_URL', '${{Postgres.DATABASE_URL}}'],
    ['PUBLIC_URL', baseUrl()], ['AUTH_SECRET', authSecret], ...signInPairs(),
    ...(state.provider === 'google' ? googlePairs() : []), ...ownerPairs(),
  ]),
  railwayWorker: () => env([
    ['PCL_ROLE', 'worker'], ['NODE_ENV', 'production'], ['DATABASE_URL', '${{Postgres.DATABASE_URL}}'],
    ...googlePairs(), ['GOOGLE_REFRESH_TOKEN_WORK', mint().token], ...ownerPairs(),
  ]),
  localEnv: () => env([
    ['DATABASE_URL', LOCAL_DB], ['NODE_ENV', 'development'], ['PUBLIC_URL', LOCAL_URL], ['AUTH_SECRET', authSecret],
    ...signInPairs(), ...googlePairs(), ['GOOGLE_REFRESH_TOKEN_WORK', mint().token], ...ownerPairs(),
  ]),
  cmdDocker: () => 'docker run -d --name grimalkin-pg --restart unless-stopped \\\n  -e POSTGRES_PASSWORD=grimalkin -e POSTGRES_DB=grimalkin \\\n  -p 127.0.0.1:5432:5432 pgvector/pgvector:pg17',
  cmdLocalSetup: () => 'pnpm db:migrate\npnpm doctor\npnpm build',
  cmdLocalRun: () => '# Window 1: the part Claude talks to\nPCL_ROLE=mcp node --env-file=.env dist/main.js\n\n# Window 2: the part that syncs your calendar\nPCL_ROLE=worker node --env-file=.env dist/main.js\n\n# On Windows PowerShell, start each with $env:PCL_ROLE="mcp"; (or "worker";) instead',
  mcpUrl: () => urlOr('/mcp'),
  cmdClaudeCode: () => `claude mcp add --transport http grimalkin ${urlOr('/mcp')}`,
  prefs: () => 'At the start of any substantive session, call `how_i_work` from the grimalkin connector to load my working preferences. When something is learned about how I like to work, record it with `note_preference`.',
}

// ── rendering ─────────────────────────────────────────────────────────────
function matches (cond) {
  const m = cond.match(/^(\w+)(!?=)(.*)$/)
  if (!m) return true
  const v = String(state[m[1]])
  return m[2] === '=' ? v === m[3] : v !== m[3]
}
const steps = $$('#steps .step')
const visibleSteps = () => steps.filter(s => !s.dataset.when || matches(s.dataset.when))

function renderBox (el) {
  const text = T[el.dataset.tpl]()
  if (!el.firstChild) {
    el.innerHTML = '<pre></pre><button class="btn small copy" type="button">Copy</button>'
    $('button', el).addEventListener('click', e => copy(T[el.dataset.tpl](), e.currentTarget))
  }
  $('pre', el).textContent = text
}

function msg (id, text, good) {
  const el = document.getElementById(id)
  if (!el) return
  el.textContent = text || ''
  el.className = 'msg' + (text ? ' show ' + (good ? 'good' : 'bad') : '')
}

function render () {
  for (const el of $$('[data-show]')) el.hidden = !matches(el.dataset.show)
  for (const el of $$('[data-tpl]')) renderBox(el)

  const vis = visibleSteps()
  state.step = Math.min(Math.max(0, state.step), vis.length - 1)
  steps.forEach(s => s.classList.toggle('active', s === vis[state.step]))
  $('#rail').innerHTML = ''
  vis.forEach((s, i) => {
    const li = document.createElement('li')
    const b = document.createElement('button')
    b.type = 'button'
    b.innerHTML = `<span class="n">${i + 1}</span><span class="t"></span>`
    $('.t', b).textContent = s.dataset.title
    if (i === state.step) b.setAttribute('aria-current', 'step')
    if (i < state.step) b.classList.add('done')
    b.addEventListener('click', () => go(i))
    li.append(b)
    $('#rail').append(li)
  })
  $('#back').style.visibility = state.step === 0 ? 'hidden' : 'visible'
  $('#next').style.visibility = state.step === vis.length - 1 ? 'hidden' : 'visible'

  // field checks
  const n = normalizeUrl(state.publicUrl)
  msg('publicUrlMsg', n.error || (n.url && n.url !== state.publicUrl.trim() ? `Got it: ${n.url}` : ''), !n.error)
  const gid = state.googleClientId.trim()
  msg('gidMsg', gid && !gid.endsWith('.apps.googleusercontent.com') ? 'A Google client ID ends in .apps.googleusercontent.com. Check you copied the ID, not the secret.' : '', false)
  const mt = mint()
  if (state.mintOutput.trim()) {
    const parts = []
    if (!mt.token) parts.push('no GOOGLE_REFRESH_TOKEN_WORK line')
    if (state.provider === 'google' && !mt.subject) parts.push('no ALLOWED_SUBJECT line')
    msg('mintMsg', parts.length ? `I can't find ${parts.join(' or ')}. Paste the whole block.` : 'Found it. Your calendar token' + (state.provider === 'google' ? ' and account number are' : ' is') + ' ready.', !parts.length)
  } else msg('mintMsg', '')
  const login = state.githubLogin.trim()
  const ghl = document.getElementById('ghLink')
  if (login && /^[A-Za-z0-9-]+$/.test(login)) {
    ghl.className = 'msg show good'
    ghl.innerHTML = ''
    const a = document.createElement('a')
    a.href = `https://api.github.com/users/${encodeURIComponent(login)}`
    a.target = '_blank'; a.rel = 'noopener'
    a.textContent = `Open ${a.href} and copy the "id" number`
    ghl.append(a)
  } else msg('ghLink', '')
  const uid = state.githubUserId.trim()
  msg('ghuidMsg', uid && !/^\d+$/.test(uid) ? 'It\'s a number, like 583231. Your username goes in the box above.' : '', false)

  const preset = OIDC[state.oidcPreset] || OIDC.other
  $('#oidcIssuer').placeholder = preset.issuer
  $('#oidcIssuerHelp').textContent = preset.help
  $('#oidcSubHelp').textContent = preset.sub
  const iss = state.oidcIssuer.trim()
  let issMsg = ''
  if (iss && !/^https:\/\//.test(iss)) issMsg = 'It must start with https://.'
  else if (/\/(common|organizations|consumers)(\/|$)/.test(iss)) issMsg = 'Use your tenant ID here, not common or organizations.'
  else if (state.oidcPreset === 'authentik' && iss && !iss.endsWith('/')) issMsg = 'Authentik issuers end with a slash.'
  else if (iss.includes('/.well-known/')) issMsg = 'Leave off the /.well-known/… part.'
  msg('oidcIssuerMsg', issMsg, false)

  $('#secretView').textContent = authSecret
  const miss = missing()
  for (const id of ['missingNote', 'missingNoteLocal']) {
    const el = document.getElementById(id)
    el.hidden = !miss.length
    $('p', el).textContent = miss.length ? `Still missing: ${miss.join('; ')}. You can go back for them, or fill them in by hand later.` : ''
  }
  const hl = $('#healthLink')
  hl.href = urlOr('/healthz'); hl.textContent = urlOr('/healthz')
  $('#signInWho').textContent = { google: 'the Google account you used in step 5', github: 'your GitHub account', oidc: 'your account at your sign-in provider' }[state.provider]
}

function go (i) {
  state.step = i
  save(); render()
  window.scrollTo({ top: 0 })
  const h = $('.step.active h2:not([hidden])')
  if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }) }
}

async function copy (text, btn) {
  try { await navigator.clipboard.writeText(text) } catch {
    const ta = document.createElement('textarea')
    ta.value = text; document.body.append(ta); ta.select()
    document.execCommand('copy'); ta.remove()
  }
  btn.textContent = 'Copied'; btn.classList.add('copied')
  setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied') }, 1500)
}

function download (text) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain' }))
  a.download = '.env'
  document.body.append(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

// ── wiring ────────────────────────────────────────────────────────────────
load()
for (const el of $$('input[type=radio]')) {
  el.checked = state[el.name] === el.value
  el.addEventListener('change', () => { state[el.name] = el.value; save(); render() })
}
for (const el of $$('[data-k]')) {
  const k = el.dataset.k
  if (el.type === 'checkbox') {
    el.checked = !!state[k]
    el.addEventListener('change', () => { state[k] = el.checked; save(); render() })
  } else {
    el.value = state[k]
    el.addEventListener('input', () => { state[k] = el.value; save(); render() })
  }
}
$('#oidcPreset').addEventListener('change', render)
$('#regen').addEventListener('click', () => { authSecret = makeSecret(); render() })
$('#back').addEventListener('click', () => go(state.step - 1))
$('#next').addEventListener('click', () => go(state.step + 1))
$('#reset').addEventListener('click', () => {
  try { localStorage.removeItem(STORE) } catch {}
  location.reload()
})
for (const b of $$('[data-download]')) {
  b.addEventListener('click', () => download(b.dataset.download === 'starter' ? T.starterEnv() : T.localEnv()))
}
render()
