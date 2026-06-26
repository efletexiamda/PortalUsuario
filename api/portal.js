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
  async function callAI(messages, system) {
    if (GROQ_KEY) {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role:'system', content:system }, ...messages],
          max_tokens: 800, temperature: 0.6
        })
      });
      if (!r.ok) throw new Error(`Groq ${r.status}`);
      const d = await r.json();
      return d.choices?.[0]?.message?.content || '';
    }
    if (GEMINI_KEY) {
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
      if (!r.ok) throw new Error(`Gemini ${r.status}`);
      const d = await r.json();
      return d.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }
    throw new Error('No hay API Key de IA configurada');
  }

  const SYSTEM = `Eres el asistente virtual de Mesa de Ayuda de Efletexia para usuarios finales.

REGLAS:
- Responde en español, de forma amable y clara
- Usa pasos numerados para instrucciones
- Máximo 250 palabras
- Cuando tengas datos reales de Jira en el contexto, úsalos directamente
- Nunca digas que no tienes acceso — sí lo tienes
- Si el usuario pregunta por un ticket específico, da información detallada del estado

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
      // Detectar si pregunta por un ticket específico
      const ticketMatch = userMsg.match(/TK-?\d+/i);
      if (ticketMatch) {
        const key = ticketMatch[0].toUpperCase().replace('TK-','TK-');
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
        }
      }

      // Buscar tickets del usuario si menciona su nombre
      if (!ticketMatch && userMsg.length > 5) {
        const words = userMsg.split(' ').filter(w => w.length > 3);
        if (words.length > 0) {
          const tickets = await searchJira(
            `project="${JIRA_PROJ}" AND summary~"${words[0]}" ORDER BY created DESC`, 5
          ).catch(() => []);
          if (tickets.length) {
            jiraCtx = `\n\nTICKETS RELACIONADOS:\n${tickets.map(t=>
              `- ${t.key}: ${t.status} | ${t.summary.slice(0,60)}`).join('\n')}`;
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
      const isKey = query.match(/^TK-?\d+$/i);
      let jql;
      if (isKey) {
        const key = query.toUpperCase().replace('TK','TK');
        jql = `key = "${key}"`;
      } else {
        jql = `project="${JIRA_PROJ}" AND (reporter~"${query}" OR summary~"${query}") ORDER BY created DESC`;
      }

      const tickets = await searchJira(jql, 20);
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
        comments
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
      const issueType = type === 'inc' ? 'Incident' : 'Service Request';
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
        throw new Error(`Jira ${r.status}: ${err.slice(0,200)}`);
      }
      const data = await r.json();
      return res.status(200).json({ key: data.key, id: data.id });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: `Acción desconocida: "${action}"` });
};
