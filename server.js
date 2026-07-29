import { createClient } from '@supabase/supabase-js';
import express from 'express';
import { randomUUID } from 'crypto';

const SUPABASE_URL = 'https://krisoqcoyicawzxpqdxw.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtyaXNvcWNveWljYXd6eHBxZHh3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUzNTUxMTksImV4cCI6MjEwMDkzMTExOX0.Oba8pH3PmEvRr6kenrZ1qcgu0Ng6mpTYJ8gAw5SAD5Q';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const app = express();
app.use(express.json());

// CORS for all routes
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ——— SUPABASE HELPERS ———
async function getProjects() {
  const { data, error } = await supabase.from('projects').select('data').order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data.map(r => r.data);
}

async function saveProject(project) {
  const { error } = await supabase.from('projects').upsert({ id: project.id, data: project }, { onConflict: 'id' });
  if (error) throw new Error(error.message);
}

function statusLabel(s) {
  const map = { 'awarded':'Awarded','planned':'Planned','inside-sales':'Waiting on Inside Sales','submittal-review':'Submittal Review by Engineer','production':'Released for Production','onsite':'Equipment Onsite','startup-scheduled':'Start-Up Scheduled','startup-complete':'Start-Up Complete','lost':'Lost' };
  return map[s] || s;
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const now = new Date(); now.setHours(0,0,0,0);
  return Math.round((new Date(dateStr + 'T00:00:00') - now) / 86400000);
}

function findProject(projects, query) {
  const q = query.toLowerCase();
  return projects.find(p => p.id === query || (p.name||'').toLowerCase().includes(q) || (p.client||'').toLowerCase().includes(q) || (p.cbOrder||'').toLowerCase().includes(q));
}

// ——— TOOLS ———
const TOOLS = [
  { name: 'get_all_projects', description: 'Get a summary of all BoilerTrack projects', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_project', description: 'Get full details of a specific project by name, client, or CB order number', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Project name, client name, CB order #, or project ID' } }, required: ['query'] } },
  { name: 'get_projects_by_status', description: 'Get projects filtered by status', inputSchema: { type: 'object', properties: { status: { type: 'string', description: 'Status name e.g. awarded, onsite, startup-scheduled' } }, required: ['status'] } },
  { name: 'get_overdue_followups', description: 'Get all projects with overdue follow-up reminders', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_upcoming_startups', description: 'Get projects with start-up dates in the next 30 days', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_pipeline_summary', description: 'Get a summary of the full pipeline with counts and values by status', inputSchema: { type: 'object', properties: {} } },
  { name: 'add_followup', description: 'Add a follow-up reminder to a project', inputSchema: { type: 'object', properties: { project_query: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' }, note: { type: 'string' } }, required: ['project_query', 'date', 'note'] } },
  { name: 'update_project_status', description: 'Update the status of a project', inputSchema: { type: 'object', properties: { project_query: { type: 'string' }, status: { type: 'string' } }, required: ['project_query', 'status'] } },
  { name: 'add_event', description: 'Add an event or note to a project', inputSchema: { type: 'object', properties: { project_query: { type: 'string' }, note: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD, optional' } }, required: ['project_query', 'note'] } }
];

async function callTool(name, args) {
  const projects = await getProjects();

  switch(name) {
    case 'get_all_projects':
      return projects.length
        ? `${projects.length} projects:\n\n` + projects.map(p => `• **${p.name}** (${p.client||'—'}) — ${statusLabel(p.status)}${p.value ? ' · $'+Number(p.value).toLocaleString() : ''}${p.startup ? ' · Start-Up: '+p.startup : ''}`).join('\n')
        : 'No projects found.';

    case 'get_project': {
      const p = findProject(projects, args.query);
      if (!p) return `No project found matching "${args.query}"`;
      const contacts = (p.contacts||[]).map(c=>`  - ${c.name} (${c.role}) ${c.phone||''} ${c.email||''}`).join('\n');
      const equipment = (p.equipment||[]).map(e=>`  - ${e.manufacturer} ${e.category} ${e.model} | ${e.capacity} | Serial: ${e.serial}`).join('\n');
      const followups = (p.followUps||[]).filter(f=>!f.done).map(f=>`  - ${f.date}: ${f.note}`).join('\n');
      return [`**${p.name}**`, `Client: ${p.client}`, `CB Order: ${p.cbOrder||'—'}`, `Status: ${statusLabel(p.status)}`, `Location: ${p.location||'—'}`, `Value: ${p.value?'$'+Number(p.value).toLocaleString():'—'}`, `Commission: ${p.commission?'$'+Number(p.commission).toLocaleString():'—'}`, `Start-Up: ${p.startup||'—'}`, `Delivery: ${p.install||'—'}`, `Install Start: ${p.installStart||'—'}`, contacts?`\nContacts:\n${contacts}`:'', equipment?`\nEquipment:\n${equipment}`:'', followups?`\nOpen Follow-Ups:\n${followups}`:'', p.notes?`\nNotes: ${p.notes}`:''].filter(Boolean).join('\n');
    }

    case 'get_projects_by_status': {
      const filtered = projects.filter(p => p.status === args.status || statusLabel(p.status).toLowerCase().includes(args.status.toLowerCase()));
      return filtered.length ? `${filtered.length} project(s):\n\n` + filtered.map(p=>`• **${p.name}** (${p.client||'—'})${p.startup?' — Start-Up: '+p.startup:''}`).join('\n') : `No projects found with status "${args.status}"`;
    }

    case 'get_overdue_followups': {
      const overdue = [];
      projects.forEach(p => (p.followUps||[]).forEach(f => { if (!f.done && f.date && daysUntil(f.date)<0) overdue.push({project:p.name,client:p.client,date:f.date,note:f.note,days:Math.abs(daysUntil(f.date))}); }));
      return overdue.length ? `${overdue.length} overdue follow-up(s):\n\n` + overdue.sort((a,b)=>b.days-a.days).map(f=>`• **${f.project}** (${f.client}) — ${f.note} | Due: ${f.date} (${f.days}d overdue)`).join('\n') : "No overdue follow-ups — you're all caught up!";
    }

    case 'get_upcoming_startups': {
      const upcoming = projects.filter(p=>p.startup&&daysUntil(p.startup)>=0&&daysUntil(p.startup)<=30).sort((a,b)=>a.startup.localeCompare(b.startup));
      return upcoming.length ? `${upcoming.length} start-up(s) in next 30 days:\n\n` + upcoming.map(p=>`• **${p.name}** (${p.client||'—'}) — ${p.startup} (${daysUntil(p.startup)}d away)${p.location?' · '+p.location:''}`).join('\n') : 'No start-ups scheduled in the next 30 days.';
    }

    case 'get_pipeline_summary': {
      const groups = {};
      let total = 0;
      projects.forEach(p => { const s=statusLabel(p.status); if(!groups[s]) groups[s]={count:0,value:0}; groups[s].count++; groups[s].value+=Number(p.value)||0; total+=Number(p.value)||0; });
      return `**Pipeline: ${projects.length} projects · $${total.toLocaleString()} total value**\n\n` + Object.entries(groups).map(([s,d])=>`• ${s}: ${d.count} project(s)${d.value?' · $'+d.value.toLocaleString():''}`).join('\n');
    }

    case 'add_followup': {
      const p = findProject(projects, args.project_query);
      if (!p) return `No project found matching "${args.project_query}"`;
      p.followUps = p.followUps||[];
      p.followUps.push({ date: args.date, note: args.note, done: false });
      p.activityLog = p.activityLog||[];
      p.activityLog.unshift({ type:'followup', ts:new Date().toISOString(), text:`Follow-up added via Claude: ${args.note} on ${args.date}` });
      await saveProject(p);
      return `✓ Follow-up added to **${p.name}**: "${args.note}" on ${args.date}`;
    }

    case 'update_project_status': {
      const p = findProject(projects, args.project_query);
      if (!p) return `No project found matching "${args.project_query}"`;
      const old = p.status;
      p.status = args.status;
      p.activityLog = p.activityLog||[];
      p.activityLog.unshift({ type:'status', ts:new Date().toISOString(), text:`Status changed from ${statusLabel(old)} to ${statusLabel(args.status)} via Claude` });
      await saveProject(p);
      return `✓ **${p.name}** updated from "${statusLabel(old)}" to "${statusLabel(args.status)}"`;
    }

    case 'add_event': {
      const p = findProject(projects, args.project_query);
      if (!p) return `No project found matching "${args.project_query}"`;
      const date = args.date || new Date().toISOString().split('T')[0];
      p.events = p.events||[];
      p.events.push({ date, note: args.note });
      p.activityLog = p.activityLog||[];
      p.activityLog.unshift({ type:'note', ts:new Date().toISOString(), text:`Event added via Claude: ${args.note}` });
      await saveProject(p);
      return `✓ Event added to **${p.name}**: "${args.note}" on ${date}`;
    }

    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ——— SESSION STORE ———
const sessions = new Map();

// ——— MCP STREAMABLE HTTP ENDPOINT (latest spec) ———
app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] || randomUUID();
  const body = req.body;

  // Handle batched or single requests
  const requests = Array.isArray(body) ? body : [body];
  const responses = [];

  for (const msg of requests) {
    const { method, params, id } = msg;
    try {
      let result;
      if (method === 'initialize') {
        sessions.set(sessionId, true);
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'boilertrack-mcp', version: '1.0.0' } };
      } else if (method === 'notifications/initialized') {
        continue;
      } else if (method === 'tools/list') {
        result = { tools: TOOLS };
      } else if (method === 'tools/call') {
        const text = await callTool(params.name, params.arguments || {});
        result = { content: [{ type: 'text', text }] };
      } else if (method === 'ping') {
        result = {};
      } else {
        result = {};
      }
      if (id !== undefined) responses.push({ jsonrpc: '2.0', id, result });
    } catch(e) {
      if (id !== undefined) responses.push({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
    }
  }

  res.setHeader('mcp-session-id', sessionId);
  res.json(responses.length === 1 ? responses[0] : responses);
});

// DELETE session
app.delete('/mcp', (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId) sessions.delete(sessionId);
  res.sendStatus(200);
});

// Legacy SSE endpoint (fallback)
app.get('/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.write(`data: ${JSON.stringify({ type: 'endpoint', url: baseUrl + '/message' })}\n\n`);
  const ka = setInterval(() => res.write(': keepalive\n\n'), 15000);
  req.on('close', () => clearInterval(ka));
});

app.post('/message', async (req, res) => {
  const { method, params, id } = req.body;
  try {
    let result;
    if (method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'boilertrack-mcp', version: '1.0.0' } };
    else if (method === 'tools/list') result = { tools: TOOLS };
    else if (method === 'tools/call') { const text = await callTool(params.name, params.arguments||{}); result = { content: [{ type:'text', text }] }; }
    else result = {};
    res.json({ jsonrpc: '2.0', id, result });
  } catch(e) { res.json({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } }); }
});

// OAuth stubs — tell Claude no auth needed
app.get('/.well-known/oauth-protected-resource', (req, res) => res.json({ resource: `https://${req.get('host')}`, authorization_servers: [] }));
app.get('/.well-known/oauth-authorization-server', (req, res) => res.json({ issuer: `https://${req.get('host')}`, token_endpoint: `https://${req.get('host')}/token`, grant_types_supported: [] }));
app.post('/token', (req, res) => res.json({ access_token: 'no-auth', token_type: 'bearer' }));

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'boilertrack-mcp' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BoilerTrack MCP running on port ${PORT}`));
