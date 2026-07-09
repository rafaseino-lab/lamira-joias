// Servidor Lamira Joias — serve o app e faz o provador com IA (OpenAI)
// Rodar local:  OPENAI_API_KEY=sua_chave node server.js
// Publicar:     Render/Railway rodam "node server.js" e leem OPENAI_API_KEY das variaveis de ambiente
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
app.use(express.json({ limit: '20mb' }));
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// senha de acesso (opcional): defina STORE_PASSWORD nas variaveis de ambiente.
// Se definida, o navegador pede usuario/senha. Usuario: qualquer coisa. Senha: a que voce definir.
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

// serve o app (lamira-joias.html deve estar na mesma pasta deste arquivo)
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'lamira-joias.html')));

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

    const e = dataUrlToBuffer(ear);
    const j = dataUrlToBuffer(jewelry);

    const form = new FormData();
    form.append('model', 'gpt-image-1');
    form.append('image[]', new Blob([e.buf], { type: e.type || 'image/png' }), 'orelha.png');
    form.append('image[]', new Blob([j.buf], { type: j.type || 'image/png' }), 'joia.png');
    form.append('prompt', prompt || PROMPT_PADRAO);
    form.append('size', '1024x1024');
    form.append('input_fidelity', 'high');
    form.append('n', '1');

    const r = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form
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
app.listen(port, () => console.log('Lamira Joias rodando na porta ' + port));
