import { createClient } from '@supabase/supabase-js';
import express from 'express';

const SUPABASE_URL = 'https://krisoqcoyicawzxpqdxw.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtyaXNvcWNveWljYXd6eHBxZHh3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUzNTUxMTksImV4cCI6MjEwMDkzMTExOX0.Oba8pH3PmEvRr6kenrZ1qcgu0Ng6mpTYJ8gAw5SAD5Q';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const app = express();
app.use(express.json());

// ——— HELPERS ———
async function getProjects() {
  const { data, error } = await supabase
    .from('projects')
    .select('data')
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data.map(r => r.data);
}

async function getProject(id) {
  const { data, error } = await supabase
    .from('projects')
    .select('data')
    .eq('id', id)
    .single();
  if (error) throw new Error(error.message);
  return data.data;
}

async function saveProject(project) {
  const { error } = await supabase
    .from('projects')
    .upsert({ id: project.id, data: project }, { onConflict: 'id' });
  if (error) throw new Error(error.message);
  return project;
}

function statusLabel(status) {
  const map = {
    'awarded': 'Awarded', 'planned': 'Planned', 'inside-sales': 'Waiting on Inside Sales',
    'submittal-review': 'Submittal Review by Engineer', 'production': 'Released for Production',
    'onsite': 'Equipment Onsite', 'startup-scheduled': 'Start-Up Scheduled',
    'startup-complete': 'Start-Up Complete', 'lost': 'Lost'
  };
  return map[status] || status;
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const now = new Date(); now.setHours(0,0,0,0);
  const then = new Date(dateStr + 'T00:00:00');
  return Math.round((then - now) / 86400000);
}

function summarizeProject(p) {
  const nextFollowUp = (p.followUps || []).filter(f => !f.done && f.date).sort((a,b) => a.date.localeCompare(b.date))[0];
  return {
    id: p.id,
    name: p.name,
    client: p.client,
    cbOrder: p.cbOrder,
    status: statusLabel(p.status),
    value: p.value ? `$${Number(p.value).toLocaleString()}` : null,
    commission: p.commission ? `$${Number(p.commission).toLocaleString()}` : null,
    startup: p.startup || null,
    delivery: p.install || null,
    installStart: p.installStart || null,
    location: p.location || null,
    nextFollowUp: nextFollowUp ? `${nextFollowUp.date} — ${nextFollowUp.note}` : null,
    notes: p.notes || null
  };
}

// ——— MCP PROTOCOL ———
// Claude connects via HTTP+SSE. We implement a simple MCP-compatible endpoint.

const TOOLS = [
  {
    name: 'get_all_projects',
    description: 'Get a summary of all BoilerTrack projects',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_project',
    description: 'Get full details of a specific project by name or ID',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Project name, client name, or project ID' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_projects_by_status',
    description: 'Get all projects filtered by status',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Status: awarded, planned, inside-sales, submittal-review, production, onsite, startup-scheduled, startup-complete, lost' }
      },
      required: ['status']
    }
  },
  {
    name: 'get_overdue_followups',
    description: 'Get all projects with overdue follow-up reminders',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_upcoming_startups',
    description: 'Get projects with start-up dates in the next 30 days',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'add_followup',
    description: 'Add a follow-up reminder to a project',
    inputSchema: {
      type: 'object',
      properties: {
        project_query: { type: 'string', description: 'Project name or client name' },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
        note: { type: 'string', description: 'Follow-up note or reminder text' }
      },
      required: ['project_query', 'date', 'note']
    }
  },
  {
    name: 'update_project_status',
    description: 'Update the status of a project',
    inputSchema: {
      type: 'object',
      properties: {
        project_query: { type: 'string', description: 'Project name or client name' },
        status: { type: 'string', description: 'New status value' }
      },
      required: ['project_query', 'status']
    }
  },
  {
    name: 'add_event',
    description: 'Add an event/note to a project activity log',
    inputSchema: {
      type: 'object',
      properties: {
        project_query: { type: 'string', description: 'Project name or client name' },
        note: { type: 'string', description: 'Event note text' },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format (optional, defaults to today)' }
      },
      required: ['project_query', 'note']
    }
  },
  {
    name: 'get_pipeline_summary',
    description: 'Get a summary of the full pipeline — counts and values by status',
    inputSchema: { type: 'object', properties: {}, required: [] }
  }
];

async function callTool(name, args) {
  const projects = await getProjects();

  function findProject(query) {
    const q = query.toLowerCase();
    return projects.find(p =>
      p.id === query ||
      (p.name || '').toLowerCase().includes(q) ||
      (p.client || '').toLowerCase().includes(q) ||
      (p.cbOrder || '').toLowerCase().includes(q)
    );
  }

  switch (name) {

    case 'get_all_projects': {
      const summaries = projects.map(summarizeProject);
      return summaries.length
        ? `Found ${summaries.length} projects:\n\n` + summaries.map(p =>
            `• **${p.name}** (${p.client}) — ${p.status}${p.value ? ' · ' + p.value : ''}${p.startup ? ' · Start-Up: ' + p.startup : ''}`
          ).join('\n')
        : 'No projects found.';
    }

    case 'get_project': {
      const p = findProject(args.query);
      if (!p) return `No project found matching "${args.query}"`;
      const s = summarizeProject(p);
      const contacts = (p.contacts || []).map(c => `  - ${c.name} (${c.role}) — ${c.phone || ''} ${c.email || ''}`).join('\n');
      const equipment = (p.equipment || []).map(e => `  - ${e.manufacturer} ${e.category} ${e.model} | ${e.capacity} | Serial: ${e.serial}`).join('\n');
      const followups = (p.followUps || []).filter(f => !f.done).map(f => `  - ${f.date}: ${f.note}`).join('\n');
      return [
        `**${p.name}**`,
        `Client: ${p.client}`,
        `CB Order: ${p.cbOrder || '—'}`,
        `Status: ${s.status}`,
        `Location: ${s.location || '—'}`,
        `Value: ${s.value || '—'}`,
        `Commission: ${s.commission || '—'}`,
        `Start-Up: ${s.startup || '—'}`,
        `Delivery: ${s.delivery || '—'}`,
        `Install Start: ${s.installStart || '—'}`,
        contacts ? `\nContacts:\n${contacts}` : '',
        equipment ? `\nEquipment:\n${equipment}` : '',
        followups ? `\nOpen Follow-Ups:\n${followups}` : '',
        p.notes ? `\nNotes: ${p.notes}` : ''
      ].filter(Boolean).join('\n');
    }

    case 'get_projects_by_status': {
      const filtered = projects.filter(p => p.status === args.status || statusLabel(p.status).toLowerCase() === args.status.toLowerCase());
      if (!filtered.length) return `No projects found with status "${args.status}"`;
      return `${filtered.length} project(s) with status "${statusLabel(args.status)}":\n\n` +
        filtered.map(p => `• **${p.name}** (${p.client})${p.startup ? ' — Start-Up: ' + p.startup : ''}`).join('\n');
    }

    case 'get_overdue_followups': {
      const overdue = [];
      projects.forEach(p => {
        (p.followUps || []).forEach(f => {
          if (!f.done && f.date && daysUntil(f.date) < 0) {
            overdue.push({ project: p.name, client: p.client, date: f.date, note: f.note, daysOverdue: Math.abs(daysUntil(f.date)) });
          }
        });
      });
      if (!overdue.length) return 'No overdue follow-ups. You\'re all caught up!';
      return `${overdue.length} overdue follow-up(s):\n\n` +
        overdue.sort((a,b) => b.daysOverdue - a.daysOverdue)
          .map(f => `• **${f.project}** (${f.client}) — ${f.note} | Due: ${f.date} (${f.daysOverdue}d overdue)`).join('\n');
    }

    case 'get_upcoming_startups': {
      const upcoming = projects
        .filter(p => p.startup && daysUntil(p.startup) !== null && daysUntil(p.startup) >= 0 && daysUntil(p.startup) <= 30)
        .sort((a,b) => a.startup.localeCompare(b.startup));
      if (!upcoming.length) return 'No start-ups scheduled in the next 30 days.';
      return `${upcoming.length} start-up(s) in the next 30 days:\n\n` +
        upcoming.map(p => `• **${p.name}** (${p.client}) — ${p.startup} (${daysUntil(p.startup)}d away)${p.location ? ' · ' + p.location : ''}`).join('\n');
    }

    case 'add_followup': {
      const p = findProject(args.project_query);
      if (!p) return `No project found matching "${args.project_query}"`;
      p.followUps = p.followUps || [];
      p.followUps.push({ date: args.date, note: args.note, done: false });
      p.activityLog = p.activityLog || [];
      p.activityLog.unshift({ type: 'followup', ts: new Date().toISOString(), text: `Follow-up added via Claude: ${args.note} on ${args.date}` });
      await saveProject(p);
      return `✓ Follow-up added to **${p.name}**: "${args.note}" on ${args.date}`;
    }

    case 'update_project_status': {
      const p = findProject(args.project_query);
      if (!p) return `No project found matching "${args.project_query}"`;
      const oldStatus = p.status;
      p.status = args.status;
      p.activityLog = p.activityLog || [];
      p.activityLog.unshift({ type: 'status', ts: new Date().toISOString(), text: `Status changed from ${statusLabel(oldStatus)} to ${statusLabel(args.status)} via Claude` });
      await saveProject(p);
      return `✓ **${p.name}** status updated from "${statusLabel(oldStatus)}" to "${statusLabel(args.status)}"`;
    }

    case 'add_event': {
      const p = findProject(args.project_query);
      if (!p) return `No project found matching "${args.project_query}"`;
      const date = args.date || new Date().toISOString().split('T')[0];
      p.events = p.events || [];
      p.events.push({ date, note: args.note });
      p.activityLog = p.activityLog || [];
      p.activityLog.unshift({ type: 'note', ts: new Date().toISOString(), text: `Event added via Claude: ${args.note}` });
      await saveProject(p);
      return `✓ Event added to **${p.name}**: "${args.note}" on ${date}`;
    }

    case 'get_pipeline_summary': {
      const statusGroups = {};
      let totalValue = 0;
      projects.forEach(p => {
        const s = statusLabel(p.status);
        if (!statusGroups[s]) statusGroups[s] = { count: 0, value: 0 };
        statusGroups[s].count++;
        statusGroups[s].value += Number(p.value) || 0;
        totalValue += Number(p.value) || 0;
      });
      const lines = Object.entries(statusGroups)
        .map(([s, d]) => `• ${s}: ${d.count} project(s)${d.value ? ' · $' + d.value.toLocaleString() : ''}`);
      return `**Pipeline Summary** — ${projects.length} total projects · $${totalValue.toLocaleString()} total value\n\n` + lines.join('\n');
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ——— MCP HTTP ENDPOINTS ———

// SSE endpoint for Claude to connect
app.get('/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Send endpoint info
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.write(`data: ${JSON.stringify({ type: 'endpoint', url: baseUrl + '/message' })}\n\n`);

  // Keep alive
  const keepAlive = setInterval(() => res.write(': keepalive\n\n'), 15000);
  req.on('close', () => clearInterval(keepAlive));
});

// Message endpoint
app.post('/message', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { method, params, id } = req.body;

  try {
    let result;

    if (method === 'initialize') {
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'boilertrack-mcp', version: '1.0.0' }
      };
    } else if (method === 'tools/list') {
      result = { tools: TOOLS };
    } else if (method === 'tools/call') {
      const text = await callTool(params.name, params.arguments || {});
      result = { content: [{ type: 'text', text }] };
    } else {
      result = {};
    }

    res.json({ jsonrpc: '2.0', id, result });
  } catch (e) {
    res.json({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
});

app.options('*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'boilertrack-mcp' }));

// Tell Claude this server requires no OAuth
app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    resource: `https://${req.get('host')}`,
    authorization_servers: []
  });
});

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    issuer: `https://${req.get('host')}`,
    token_endpoint: `https://${req.get('host')}/token`,
    response_types_supported: [],
    grant_types_supported: []
  });
});

// No-op token endpoint
app.post('/token', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ access_token: 'no-auth', token_type: 'bearer' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BoilerTrack MCP Server running on port ${PORT}`));
