// ═══════════════════════════════════════════════════════════
//  api/portal.js  —  Portal de Autoservicio · Efletexia
//  Consulta Jira + IA para usuarios finales
// ═══════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const GROQ_KEY   = process.env.GROQ_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const JIRA_EMAIL = process.env.JIRA_EMAIL;
  const JIRA_TOKEN = process.env.JIRA_TOKEN;
  const JIRA_URL   = process.env.JIRA_URL   || 'https://efletexia.atlassian.net';
  const JIRA_PROJ  = process.env.JIRA_PROJECT_KEY || 'TK';

  const body   = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const action = body.action;

  // ── Auth Jira ──────────────────────────────────────────
  const jiraAuth = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
  const JH = {
    'Authorization': `Basic ${jiraAuth}`,
    'Accept':        'application/json',
    'Content-Type':  'application/json'
  };

  // ── Extraer texto de ADF (Jira format) ────────────────
  function extractText(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (node.type === 'text') return node.text || '';
    if (node.content) return node.content.map(extractText).join(' ');
    return '';
  }

  // ── Buscar tickets en Jira ────────────────────────────
  async function searchJira(jql, maxResults = 15) {
    const fields = ['summary','status','issuetype','assignee','reporter',
                    'created','customfield_10393','customfield_10010','description','comment'];
    const r = await fetch(`${JIRA_URL}/rest/api/3/search/jql`, {
      method: 'POST', headers: JH,
      body: JSON.stringify({ jql, fields, maxResults })
    });
    if (!r.ok) throw new Error(`Jira ${r.status}`);
    const data = await r.json();
    return (data.issues || []).map(iss => {
      const f = iss.fields || {};
      const comments = (f.comment?.comments || []).map(c => ({
        author: c.author?.displayName || '',
        date:   (c.created||'').slice(0,10),
        text:   extractText(c.body).slice(0,200)
      }));
      return {
        key:         iss.key,
        summary:     f.summary || '',
        status:      f.status?.name || '',
        issuetype:   f.issuetype?.name || '',
        assignee:    f.assignee?.displayName || 'Sin asignar',
        reporter:    f.reporter?.displayName || '',
        created:     (f.created||'').slice(0,10),
        area:        f.customfield_10393?.value || '',
        requesttype: f.customfield_10010?.requestType?.name || '',
        description: extractText(f.description).slice(0,400),
        comments
      };
    });
  }

  // ── Llamar a IA ───────────────────────────────────────
  function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

  async function callGroq(messages, system) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role:'system', content:system }, ...messages],
        max_tokens: 800, temperature: 0.6
      })
    });
    if (!r.ok) { const err = new Error(`Groq ${r.status}`); err.status = r.status; throw err; }
    const d = await r.json();
    return d.choices?.[0]?.message?.content || '';
  }

  async function callGemini(messages, system) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
    const contents = [
      { role:'user',  parts:[{text:system}] },
      { role:'model', parts:[{text:'Entendido.'}] },
      ...messages.map(m=>({ role:m.role==='assistant'?'model':'user', parts:[{text:m.content}] }))
    ];
    const r = await fetch(url, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ contents, generationConfig:{maxOutputTokens:800,temperature:0.6} })
    });
    if (!r.ok) { const err = new Error(`Gemini ${r.status}`); err.status = r.status; throw err; }
    const d = await r.json();
    return d.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  // Reintenta con backoff cuando el proveedor responde 429 (cuota agotada / rate limit)
  async function withRetry(fn, retries = 2, delayMs = 800) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const is429 = e.status === 429 || /429/.test(e.message || '');
        if (!is429 || attempt === retries) throw e;
        await sleep(delayMs * (attempt + 1));
      }
    }
  }

  async function callAI(messages, system) {
    const providers = [];
    if (GROQ_KEY)   providers.push(() => withRetry(() => callGroq(messages, system)));
    if (GEMINI_KEY) providers.push(() => withRetry(() => callGemini(messages, system)));
    if (!providers.length) throw new Error('No hay API Key de IA configurada');

    let lastErr;
    for (const call of providers) {
      try {
        return await call();
      } catch (e) {
        lastErr = e;
      }
    }
    // Todos los proveedores fallaron (ej. ambos con cuota agotada)
    const friendly = new Error('El asistente está muy solicitado en este momento. Por favor intenta nuevamente en unos segundos.');
    friendly.cause = lastErr;
    throw friendly;
  }

  const SYSTEM = `Eres el asistente virtual de Mesa de Ayuda de Efletexia para usuarios finales.

REGLAS:
- Responde en español, de forma amable y clara
- Usa pasos numerados para instrucciones
- Máximo 250 palabras
- Cuando tengas datos reales de Jira en el contexto, úsalos directamente
- Nunca digas que no tienes acceso — sí lo tienes
- Si el usuario pregunta por un ticket específico, da información detallada del estado
- Si el usuario hace una pregunta general de "cómo hacer algo" (ej. "cómo libero una OPL"), busca en
  la sección "TICKETS RESUELTOS SIMILARES" del contexto y explica la solución real aplicada en esos
  casos, en pasos claros. Menciona el número de ticket (ej. TK-123) como referencia si es útil.
- Si no hay tickets resueltos similares en el contexto, dilo con honestidad y sugiere crear un
  "Nuevo Ticket" para que el equipo de soporte lo atienda directamente

TONO: Amable, profesional, orientado al usuario`;

  // ══════════════════════════════════════════════════════
  //  ACCIÓN: chat
  // ══════════════════════════════════════════════════════
  if (action === 'chat') {
    const { messages } = body;
    if (!messages?.length) return res.status(400).json({ error: 'Falta messages' });

    const userMsg = messages[messages.length-1]?.content || '';
    let jiraCtx = '';

    try {
      // Detectar si pregunta por un ticket específico (admite "TK691", "TK-691", "TK 691", minúsculas, etc.)
      const ticketMatch = userMsg.match(/TK[\s-]?(\d+)/i);
      if (ticketMatch) {
        const key = `${JIRA_PROJ}-${ticketMatch[1]}`;
        const r = await fetch(`${JIRA_URL}/rest/api/3/issue/${key}`, { headers: JH });
        if (r.ok) {
          const d = await r.json();
          const f = d.fields || {};
          const comments = (f.comment?.comments||[]).slice(-2).map(c=>({
            author: c.author?.displayName||'',
            text: extractText(c.body).slice(0,150)
          }));
          jiraCtx = `\n\n=== DATOS DEL TICKET ${key} ===
RESUMEN: ${f.summary}
ESTADO: ${f.status?.name}
TIPO: ${f.issuetype?.name}
ÁREA: ${f.customfield_10393?.value||'No especificada'}
ASIGNADO A: ${f.assignee?.displayName||'Sin asignar'}
INFORMADOR: ${f.reporter?.displayName}
CREADO: ${(f.created||'').slice(0,10)}
${f.description?`DESCRIPCIÓN: ${extractText(f.description).slice(0,200)}`:''}
${comments.length?`ÚLTIMOS COMENTARIOS:\n${comments.map(c=>`- ${c.author}: ${c.text}`).join('\n')}`:''}
===`;
        } else {
          jiraCtx = `\n\n=== TICKET ${key} ===\nNo se encontró ningún ticket con ese número. Informa al usuario que verifique el número e intente de nuevo.\n===`;
        }
      }

      // Preguntas generales ("¿cómo libero una OPL?", etc.): buscar en tickets YA
      // RESUELTOS palabras clave relevantes y usar su solución real como base de conocimiento.
      if (!ticketMatch && userMsg.length > 5) {
        const STOPWORDS = new Set(['como','cómo','para','que','qué','una','uno','unos','unas','los',
          'las','del','con','por','favor','ayuda','ayudame','ayúdame','necesito','quiero','puedo',
          'podria','podría','tengo','tener','hola','buenas','gracias','este','esta','estos','estas',
          'cual','cuál','cuales','cuáles','donde','dónde','cuando','cuándo','pero','porque','sobre',
          'hacer','hace','tiene','sido']);
        const keywords = [...new Set(
          userMsg.toLowerCase()
            .replace(/[¿?¡!.,;:]/g,'')
            .split(/\s+/)
            .filter(w => w.length >= 3 && !STOPWORDS.has(w))
        )].slice(0, 4);

        if (keywords.length > 0) {
          const clauses = keywords.map(k => `summary ~ "${k}" OR description ~ "${k}"`).join(' OR ');
          // statusCategory = Done cubre "Resuelto", "Cerrado", "Done", etc. sin depender del idioma exacto
          const tickets = await searchJira(
            `project="${JIRA_PROJ}" AND statusCategory = Done AND (${clauses}) ORDER BY updated DESC`, 5
          ).catch(() => []);

          if (tickets.length) {
            jiraCtx = `\n\nTICKETS RESUELTOS SIMILARES (usa la solución real aplicada en estos casos para explicar los pasos al usuario):\n${
              tickets.map(t => {
                const lastComments = (t.comments||[]).slice(-2)
                  .map(c => `  · ${c.author}: ${c.text}`).join('\n');
                return `- ${t.key} [${t.status}]: ${t.summary}\n  Descripción: ${t.description?.slice(0,200)||'—'}${lastComments?`\n  Solución/comentarios:\n${lastComments}`:''}`;
              }).join('\n')
            }`;
          }
        }
      }
    } catch {}

    const augmented = [...messages];
    if (jiraCtx) {
      augmented[augmented.length-1] = {
        ...augmented[augmented.length-1],
        content: augmented[augmented.length-1].content + jiraCtx
      };
    }

    try {
      const response = await callAI(augmented, SYSTEM);
      return res.status(200).json({ response });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ══════════════════════════════════════════════════════
  //  ACCIÓN: searchTickets
  // ══════════════════════════════════════════════════════
  if (action === 'searchTickets') {
    const { query } = body;
    if (!query) return res.status(400).json({ error: 'Falta query' });

    try {
      const isKey   = query.match(/^TK[\s-]?(\d+)$/i);
      const isEmail = query.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
      let jql;
      if (isKey) {
        const key = `${JIRA_PROJ}-${isKey[1]}`;
        jql = `key = "${key}"`;
      } else if (isEmail) {
        // Coincidencia exacta por correo del informador (historial del usuario)
        jql = `project="${JIRA_PROJ}" AND reporter = "${query}" ORDER BY created DESC`;
      } else {
        jql = `project="${JIRA_PROJ}" AND (reporter~"${query}" OR summary~"${query}") ORDER BY created DESC`;
      }

      let tickets = await searchJira(jql, 20).catch(err => {
        if (isEmail) return null; // señal de que falló la búsqueda exacta por correo
        throw err;
      });
      // Si la búsqueda exacta por correo no trajo resultados (o falló), reintenta
      // buscando de forma aproximada por el nombre de usuario dentro del correo.
      if (isEmail && (!tickets || tickets.length === 0)) {
        const namePart = query.split('@')[0].replace(/[._-]/g, ' ');
        const fallbackJql = `project="${JIRA_PROJ}" AND reporter~"${namePart}" ORDER BY created DESC`;
        tickets = await searchJira(fallbackJql, 20).catch(() => []);
      }

      const stats = {
        total:    tickets.length,
        pending:  tickets.filter(t => !['Resuelto','Cancelado'].some(s => t.status.includes(s))).length,
        resolved: tickets.filter(t => t.status.toLowerCase().includes('resuelto')).length
      };

      return res.status(200).json({ tickets, stats });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ══════════════════════════════════════════════════════
  //  ACCIÓN: getTicket
  // ══════════════════════════════════════════════════════
  if (action === 'getTicket') {
    const { key } = body;
    if (!key) return res.status(400).json({ error: 'Falta key' });

    try {
      const r = await fetch(`${JIRA_URL}/rest/api/3/issue/${key}`, { headers: JH });
      if (!r.ok) throw new Error(`Ticket no encontrado`);
      const d = await r.json();
      const f = d.fields || {};
      const comments = (f.comment?.comments||[]).map(c => ({
        author: c.author?.displayName||'',
        date:   (c.created||'').slice(0,10),
        text:   extractText(c.body).slice(0,300)
      }));
      return res.status(200).json({
        key:         d.key,
        summary:     f.summary||'',
        status:      f.status?.name||'',
        issuetype:   f.issuetype?.name||'',
        assignee:    f.assignee?.displayName||'Sin asignar',
        reporter:    f.reporter?.displayName||'',
        created:     (f.created||'').slice(0,10),
        area:        f.customfield_10393?.value||'',
        description: extractText(f.description),
        comments,
        attachments: (f.attachment||[]).map(a => ({
          filename: a.filename,
          url:      a.content,
          size:     a.size
        }))
      });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ══════════════════════════════════════════════════════
  //  ACCIÓN: createTicket
  // ══════════════════════════════════════════════════════
  if (action === 'createTicket') {
    const { summary, description, reporter, email, type, area, app } = body;
    if (!summary || !description) return res.status(400).json({ error: 'Faltan campos' });

    try {
      // Obtener los tipos de incidencia válidos configurados en el proyecto de Jira,
      // en vez de asumir nombres fijos en inglés (evita el error "tipo de incidencia inválido")
      const metaR = await fetch(
        `${JIRA_URL}/rest/api/3/issue/createmeta?projectKeys=${JIRA_PROJ}&expand=projects.issuetypes`,
        { headers: JH }
      );
      let availableTypes = [];
      if (metaR.ok) {
        const meta = await metaR.json();
        availableTypes = meta.projects?.[0]?.issuetypes?.map(it => it.name) || [];
      }

      // Palabras clave a buscar según el tipo elegido por el usuario en el formulario
      const keywords = type === 'inc'
        ? ['incident', 'incidente', 'falla', 'bug']
        : ['service request', 'solicitud', 'servicio', 'task', 'tarea'];

      let issueType = availableTypes.find(name =>
        keywords.some(k => name.toLowerCase().includes(k))
      );
      // Si no hay coincidencia por palabra clave, usar el primer tipo disponible del proyecto
      if (!issueType) issueType = availableTypes[0];
      // Último recurso si no se pudo leer el metadata del proyecto
      if (!issueType) issueType = type === 'inc' ? 'Incidente' : 'Solicitud de servicio';

      const fullDesc = `${description}\n\n---\nInformado por: ${reporter} (${email})${app?`\nAplicación: ${app}`:''}`;

      const payload = {
        fields: {
          project:     { key: JIRA_PROJ },
          summary:     summary,
          issuetype:   { name: issueType },
          description: {
            type: 'doc', version: 1,
            content: [{ type:'paragraph', content:[{ type:'text', text:fullDesc }] }]
          }
        }
      };

      const r = await fetch(`${JIRA_URL}/rest/api/3/issue`, {
        method: 'POST', headers: JH, body: JSON.stringify(payload)
      });
      if (!r.ok) {
        const err = await r.text();
        throw new Error(`Jira ${r.status}: ${err.slice(0,200)}${availableTypes.length?` | Tipos válidos del proyecto: ${availableTypes.join(', ')}`:''}`);
      }
      const data = await r.json();
      return res.status(200).json({ key: data.key, id: data.id });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ══════════════════════════════════════════════════════
  //  ACCIÓN: addAttachment
  // ══════════════════════════════════════════════════════
  if (action === 'addAttachment') {
    const { key, filename, contentType, dataBase64 } = body;
    if (!key || !filename || !dataBase64) return res.status(400).json({ error: 'Faltan campos' });

    try {
      const buffer = Buffer.from(dataBase64, 'base64');
      const blob = new Blob([buffer], { type: contentType || 'application/octet-stream' });
      const form = new FormData();
      form.append('file', blob, filename);

      const r = await fetch(`${JIRA_URL}/rest/api/3/issue/${key}/attachments`, {
        method: 'POST',
        headers: {
          'Authorization':      `Basic ${jiraAuth}`,
          'X-Atlassian-Token':  'no-check'
          // No se define Content-Type: fetch arma el multipart/form-data correcto a partir de FormData
        },
        body: form
      });
      if (!r.ok) {
        const err = await r.text();
        throw new Error(`Jira ${r.status}: ${err.slice(0,200)}`);
      }
      const data = await r.json();
      return res.status(200).json({ ok: true, attachment: data[0] || null });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ══════════════════════════════════════════════════════
  //  ACCIÓN: downloadAttachment (proxy autenticado hacia Jira)
  // ══════════════════════════════════════════════════════
  if (action === 'downloadAttachment') {
    const { url } = body;
    if (!url) return res.status(400).json({ error: 'Falta url' });
    if (!url.startsWith(JIRA_URL)) return res.status(400).json({ error: 'URL no permitida' });

    try {
      const r = await fetch(url, { headers: JH });
      if (!r.ok) throw new Error(`No se pudo descargar el adjunto (${r.status})`);
      const buffer = Buffer.from(await r.arrayBuffer());
      res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
      res.setHeader('Content-Disposition', r.headers.get('content-disposition') || 'inline');
      return res.status(200).send(buffer);
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: `Acción desconocida: "${action}"` });
};
