/**
 * Netlify Background Function: Feasibility Summary
 *
 * Receives HubSpot webhook events when notes are created/updated,
 * fetches all notes + deal data, generates a risk summary via Claude,
 * and writes it back to the deal's feasibility_summary property.
 *
 * Background function (-background suffix) returns 202 immediately
 * and processes asynchronously (up to 15 min).
 */

import Anthropic from '@anthropic-ai/sdk';

const HUBSPOT_API_BASE = 'https://api.hubapi.com';

const DEAL_PROPERTIES = [
  // Loan details
  'dealname', 'dealstage', 'pipeline',
  'loan_amount', 'total_loan_amount', 'b_piece',
  'loan_type', 'term__months_', 'loan_product', 'ltc',
  // Property info
  'full_address', 'property_type', 'property_age',
  'acres__formula_', 'occupancy', 'county',
  // Rehab / Scope of Work
  'construction_budget', 'proposed_sow', 'rehab_budget_notes',
  'rehab_per_sf', 'rehab_intensity', 'rehab___of_pp',
  // Valuation / ARV
  'arv__floor_', 'arv__backflip_', 'after_repair_value',
  'after_repair_value_analysis', 'dqa_arv',
  'predicted_arv_minus_appraised_arv', 'appraisal',
  // Feasibility status
  'feasibility_review', 'feasibility_notes', 'feasibility_analyst',
  'feasibility_report', 'feasibility_documentation', 'ols_feasibility_notes',
  // Other
  'contract_status', 'licensed_gc_on_deal_', 'underwriter',
];

const NOTE_PROPERTIES = ['hs_note_body', 'hs_timestamp', 'hs_created_by'];

const SYSTEM_PROMPT = `You are a senior feasibility risk analyst in real estate lending. You review scope-of-work notes and deal data during loan underwriting and produce a concise, professional risk summary.

You receive two inputs:
1. DEAL PROFILE — structured data from the loan file (financials, property info, rehab budget, valuations)
2. ANALYST NOTES — chronological raw notes from the feasibility analyst's scope-of-work review

Your output must be a concise paragraph (3-4 sentences max) that:
- States the top risks and unresolved items from the notes and deal data
- Flags key discrepancies (budget vs. scope, ARV variance, LTC, property classification)
- Notes any items blocking feasibility order or requiring borrower action
- Uses professional, direct language — no filler or preamble

If no material risks are identified, state that in one sentence.
Output ONLY the plain-text paragraph. No headers, bullets, markdown, or preamble.`;

const MAX_INPUT_CHARS = 32000;

// --- HubSpot API helpers ---

async function hubspotFetch(path, options = {}) {
  const url = `${HUBSPOT_API_BASE}${path}`;
  const headers = {
    'Authorization': `Bearer ${process.env.HUBSPOT_API_KEY}`,
    'Content-Type': 'application/json',
    ...options.headers,
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(url, { ...options, headers });
    if (resp.status === 429) {
      const wait = Math.pow(2, attempt) * 1000;
      console.log(`Rate limited, retrying in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HubSpot API ${resp.status}: ${text}`);
    }
    return resp.json();
  }
  throw new Error('HubSpot API: max retries exceeded');
}

async function getDealIdsForEngagement(engagementId) {
  const data = await hubspotFetch(
    `/crm/v4/objects/notes/${engagementId}/associations/deals`
  );
  return (data.results || []).map(r => String(r.toObjectId));
}

async function getNotesForDeal(dealId) {
  // Get note IDs associated with the deal
  const assocData = await hubspotFetch(
    `/crm/v4/objects/deals/${dealId}/associations/notes`
  );
  const noteIds = (assocData.results || []).map(r => String(r.toObjectId));
  if (noteIds.length === 0) return [];

  // Batch-read note bodies
  const batchData = await hubspotFetch('/crm/v3/objects/notes/batch/read', {
    method: 'POST',
    body: JSON.stringify({
      properties: NOTE_PROPERTIES,
      inputs: noteIds.map(id => ({ id })),
    }),
  });

  const notes = (batchData.results || []).map(r => ({
    id: r.id,
    body: r.properties?.hs_note_body || '',
    timestamp: r.properties?.hs_timestamp || '',
    createdBy: r.properties?.hs_created_by || '',
  }));

  // Sort chronologically (oldest first)
  notes.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  return notes;
}

async function getDealProperties(dealId) {
  const propsParam = DEAL_PROPERTIES.join(',');
  const data = await hubspotFetch(
    `/crm/v3/objects/deals/${dealId}?properties=${propsParam}`
  );
  return data.properties || {};
}

async function updateDealFeasibilitySummary(dealId, summary) {
  await hubspotFetch(`/crm/v3/objects/deals/${dealId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: { feasibility_summary: summary } }),
  });
  console.log(`Updated feasibility_summary for deal ${dealId}`);
}

// --- Formatting helpers ---

function stripHtml(text) {
  return text.replace(/<[^>]+>/g, '');
}

function formatDealProfile(properties) {
  const sections = {
    'Loan Details': [
      'dealname', 'dealstage', 'pipeline',
      'loan_amount', 'total_loan_amount', 'b_piece',
      'loan_type', 'term__months_', 'loan_product', 'ltc',
    ],
    'Property Info': [
      'full_address', 'property_type', 'property_age',
      'acres__formula_', 'occupancy', 'county',
    ],
    'Rehab / Scope of Work': [
      'construction_budget', 'proposed_sow', 'rehab_budget_notes',
      'rehab_per_sf', 'rehab_intensity', 'rehab___of_pp',
    ],
    'Valuation / ARV': [
      'arv__floor_', 'arv__backflip_', 'after_repair_value',
      'after_repair_value_analysis', 'dqa_arv',
      'predicted_arv_minus_appraised_arv', 'appraisal',
    ],
    'Feasibility Status': [
      'feasibility_review', 'feasibility_notes', 'feasibility_analyst',
      'feasibility_report', 'feasibility_documentation', 'ols_feasibility_notes',
    ],
    'Other': [
      'contract_status', 'licensed_gc_on_deal_', 'underwriter',
    ],
  };

  const lines = [];
  for (const [section, keys] of Object.entries(sections)) {
    const sectionLines = [];
    for (const key of keys) {
      const val = properties[key];
      if (val !== null && val !== undefined && String(val).trim()) {
        const label = key.replace(/_/g, ' ').replace(/  /g, ' ').trim()
          .replace(/\b\w/g, c => c.toUpperCase());
        sectionLines.push(`  ${label}: ${val}`);
      }
    }
    if (sectionLines.length > 0) {
      lines.push(`[${section}]`);
      lines.push(...sectionLines);
      lines.push('');
    }
  }

  return lines.length > 0 ? lines.join('\n').trim() : '(No deal data available)';
}

function formatNotes(notes) {
  const parts = [];
  for (const note of notes) {
    const body = stripHtml(note.body || '').trim();
    if (!body) continue;
    const ts = note.timestamp || 'unknown date';
    parts.push(`[${ts}]\n${body}`);
  }
  return parts.length > 0 ? parts.join('\n\n---\n\n') : '(No notes)';
}

function truncateInput(dealProfile, notesText) {
  const total = dealProfile.length + notesText.length;
  if (total <= MAX_INPUT_CHARS) return { dealProfile, notesText };

  let budget = MAX_INPUT_CHARS - dealProfile.length;
  if (budget < 500) {
    dealProfile = dealProfile.slice(0, MAX_INPUT_CHARS / 2);
    budget = MAX_INPUT_CHARS / 2;
  }
  // Keep the tail (most recent notes)
  notesText = notesText.slice(-budget);
  console.log(`Truncated notes to ${notesText.length} chars`);
  return { dealProfile, notesText };
}

// --- Claude API ---

async function generateFeasibilitySummary(dealProperties, notes) {
  const rawProfile = formatDealProfile(dealProperties);
  const rawNotes = formatNotes(notes);
  const { dealProfile, notesText } = truncateInput(rawProfile, rawNotes);

  const userMessage = `DEAL PROFILE:\n${dealProfile}\n\nANALYST NOTES (chronological):\n${notesText}`;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const summary = response.content[0].text.trim();
  console.log(`Generated feasibility summary (${summary.length} chars)`);
  return summary;
}

// --- Orchestrator ---

async function processDeal(dealId) {
  console.log(`Processing deal ${dealId}`);

  const notes = await getNotesForDeal(dealId);
  if (notes.length === 0) {
    console.log(`Deal ${dealId} has no notes, skipping`);
    return;
  }

  const dealProperties = await getDealProperties(dealId);
  const summary = await generateFeasibilitySummary(dealProperties, notes);
  await updateDealFeasibilitySummary(dealId, summary);
  console.log(`Feasibility summary updated for deal ${dealId}`);
}

async function processEngagement(engagementId) {
  console.log(`Processing engagement ${engagementId}`);

  const dealIds = await getDealIdsForEngagement(engagementId);
  if (dealIds.length === 0) {
    console.log(`Engagement ${engagementId} has no associated deals, skipping`);
    return;
  }

  for (const dealId of dealIds) {
    try {
      await processDeal(dealId);
    } catch (err) {
      console.error(`Failed to process deal ${dealId}:`, err.message);
    }
  }
}

// --- Main handler ---

export async function handler(event) {
  console.log('Feasibility summary function triggered');

  if (event.httpMethod === 'GET') {
    return { statusCode: 200, body: 'Feasibility summary webhook active' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    if (!process.env.HUBSPOT_API_KEY) {
      throw new Error('HUBSPOT_API_KEY not configured');
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not configured');
    }

    const events = JSON.parse(event.body);
    console.log(`Processing ${events.length} events`);

    // Collect unique engagement IDs from note-related events
    const engagementIds = new Set();
    for (const evt of events) {
      const subType = evt.subscriptionType || '';
      if (subType === 'engagement.creation' || subType === 'engagement.propertyChange') {
        const eid = String(evt.objectId || '');
        if (eid) engagementIds.add(eid);
      }
    }

    console.log(`Found ${engagementIds.size} unique engagement(s) to process`);

    for (const eid of engagementIds) {
      await processEngagement(eid);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, processed: engagementIds.size }),
    };
  } catch (error) {
    console.error('Error processing webhook:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
}
