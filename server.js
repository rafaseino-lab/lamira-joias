// Servidor Lamira Joias — serve o app, guarda os dados online (Postgres) e faz o provador com IA.
// Variaveis de ambiente:
//   OPENAI_API_KEY  -> chave da OpenAI (provador com IA)
//   STORE_PASSWORD  -> senha geral de acesso ao site (opcional)
//   DATABASE_URL    -> conexao Postgres (Neon). Sem ela, os dados NAO ficam salvos no servidor.
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';
const { Pool } = pkg;

const app = express();
app.use(express.json({ limit: '25mb' }));
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Banco de dados ----------
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;
let memory = null; // fallback em memoria (nao persiste) quando nao ha DATABASE_URL

async function initDb() {
  if (!pool) { console.warn('ATENCAO: DATABASE_URL nao definida — dados nao serao salvos no servidor.'); return; }
  await pool.query('CREATE TABLE IF NOT EXISTS lamira_app_state (id INT PRIMARY KEY, data JSONB NOT NULL)');
  console.log('Banco de dados pronto.');
}
async function getState() {
  if (!pool) return memory;
  const r = await pool.query('SELECT data FROM lamira_app_state WHERE id=1');
  return r.rows[0] ? r.rows[0].data : null;
}
async function setState(data) {
  if (!pool) { memory = data; return; }
  await pool.query('INSERT INTO lamira_app_state (id,data) VALUES (1,$1) ON CONFLICT (id) DO UPDATE SET data=$1', [data]);
}
// Une os estados: mantem TODAS as vendas (dos dois lados) respeitando exclusoes,
// e usa o restante (estoque, config, funcionarias) do estado que chegou (mais recente).
function mergeState(oldS, incoming) {
  if (!oldS) return incoming;
  const del = new Set([...(oldS.deletedVendaIds || []), ...(incoming.deletedVendaIds || [])]);
  const byId = {};
  [...(oldS.vendas || []), ...(incoming.vendas || [])].forEach(v => { if (v && !del.has(v.id)) byId[v.id] = v; });
  const vendas = Object.values(byId).sort((a, z) => (a.id || 0) - (z.id || 0));
  return { ...incoming, vendas, deletedVendaIds: [...del] };
}

// ---------- Senha de acesso (opcional) ----------
const STORE_PASSWORD = process.env.STORE_PASSWORD;
if (STORE_PASSWORD) {
  app.use((req, res, next) => {
    const h = req.headers.authorization || '';
    const b64 = h.startsWith('Basic ') ? h.slice(6) : '';
    const pw = Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':');
    if (pw === STORE_PASSWORD) return next();
    res.set('WWW-Authenticate', 'Basic realm="Lamira Joias"').status(401).send('Acesso restrito.');
  });
}

// ---------- API de dados ----------
app.get('/api/data', async (req, res) => {
  try { res.json({ data: await getState() }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/data', async (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'dados invalidos' });
    const merged = mergeState(await getState(), incoming);
    await setState(merged);
    res.json({ data: merged });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------- App estatico ----------
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'lamira-joias.html')));

// ---------- Provador com IA ----------
function dataUrlToBuffer(d) {
  const m = /^data:(.+?);base64,(.*)$/.exec(d || '');
  if (!m) throw new Error('imagem inválida');
  return { type: m[1], buf: Buffer.from(m[2], 'base64') };
}
const PROMPT_PADRAO =
  'Coloque a joia/brinco da segunda imagem na orelha da primeira imagem, ' +
  'posicionada no lóbulo (ou no ponto natural da orelha) de forma realista, ' +
  'com iluminação, reflexos e sombras coerentes com a foto. ' +
  'Mantenha EXATAMENTE o desenho, as pedras, a cor e o formato da joia — não invente detalhes. ' +
  'Não altere o rosto, o cabelo nem a forma da orelha. Resultado fotorrealista.';

app.post('/api/provador', async (req, res) => {
  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return res.status(500).json({ error: 'OPENAI_API_KEY não configurada no servidor.' });
    const { ear, jewelry, prompt } = req.body || {};
    if (!ear || !jewelry) return res.status(400).json({ error: 'Envie a foto da orelha e da joia.' });
    const e = dataUrlToBuffer(ear), j = dataUrlToBuffer(jewelry);
    const form = new FormData();
    form.append('model', 'gpt-image-1');
    form.append('image[]', new Blob([e.buf], { type: e.type || 'image/png' }), 'orelha.png');
    form.append('image[]', new Blob([j.buf], { type: j.type || 'image/png' }), 'joia.png');
    form.append('prompt', prompt || PROMPT_PADRAO);
    form.append('size', '1024x1024');
    form.append('input_fidelity', 'high');
    form.append('n', '1');
    const r = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || 'Erro na OpenAI.' });
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) return res.status(500).json({ error: 'A OpenAI não retornou imagem.' });
    res.json({ image: `data:image/png;base64,${b64}` });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

const port = process.env.PORT || 3000;
initDb().catch(e => console.error('Erro no banco:', e.message)).finally(() => {
  app.listen(port, () => console.log('Lamira Joias rodando na porta ' + port));
});
