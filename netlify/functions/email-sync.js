/**
 * Netlify Function: Email Sync Webhook
 * Handles HubSpot webhook events for email sync
 *
 * Features:
 * - Deduplicates events within a batch
 * - Retries with backoff on rate limits (429)
 * - Matches by loan number, address, and deal name
 * - 95% confidence threshold
 * - Fallback: if contact has exactly one deal, assumes that's the match
 * - Throttles API calls to stay within HubSpot limits
 */

import fetch from 'node-fetch';

// HubSpot API base URL
const HUBSPOT_API_BASE = 'https://api.hubapi.com';

// Target deal stages
const TARGET_STAGES = {
  presentationScheduled: 'presentationscheduled',
  postFunded: 'closedwon',
  sold: '4447566'
};

// Minimum confidence to auto-associate
const CONFIDENCE_THRESHOLD = 95;

// --- HubSpot API helper with retry ---

async function hubspotRequest(apiKey, endpoint, options = {}, retries = 3) {
  const url = `${HUBSPOT_API_BASE}${endpoint}`;
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...options.headers
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { ...options, headers });

      if (response.status === 429) {
        if (attempt < retries) {
          const retryAfter = response.headers.get('retry-after');
          const delay = retryAfter ? parseInt(retryAfter) * 1000 : (attempt + 1) * 1000;
          console.warn(`Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
          await sleep(delay);
          continue;
        }
      }

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(`HubSpot API Error (${response.status}): ${error.message || response.statusText}`);
      }

      if (response.status === 204) return {};
      return await response.json();
    } catch (error) {
      if (attempt < retries && error.message?.includes('secondly limit')) {
        await sleep((attempt + 1) * 1000);
        continue;
      }
      throw error;
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Email parser ---

function parseEmail(subject, body) {
  const text = `${subject || ''}\n${body || ''}`;

  return {
    loanNumbers: extractLoanNumbers(text),
    addresses: extractAddresses(text),
    dealNames: extractDealNames(text),
    hasServicer: /\b(FCI|GLS)\b/i.test(text)
  };
}

function extractLoanNumbers(text) {
  const loanNumbers = new Set();
  const hasServicer = /\b(FCI|GLS)\b/i.test(text);

  // Loan numbers with context keywords
  const loanPattern = hasServicer
    ? /\b(?:loans?|deals?)\s*(?:number|#|no\.?|num\.?)?\s*:?\s*(\d{5,10})\b/gi
    : /\b(?:loans?|deals?)\s*(?:number|#|no\.?|num\.?)?\s*:?\s*(\d{5,6})\b/gi;

  let match;
  while ((match = loanPattern.exec(text)) !== null) {
    loanNumbers.add(match[1]);
  }

  // Subject line after RE:/FW:
  const lines = text.split('\n');
  if (lines.length > 0) {
    const subjectPattern = hasServicer
      ? /\b(?:RE:|FW:)\s*(\d{5,10})\b/gi
      : /\b(?:RE:|FW:)\s*(\d{5,6})\b/gi;
    while ((match = subjectPattern.exec(lines[0])) !== null) {
      loanNumbers.add(match[1]);
    }
  }

  // BF-YYYY-NNNN format
  const bfPattern = /\b(BF[-\s]?\d{4}[-\s]?\d{4})\b/gi;
  while ((match = bfPattern.exec(text)) !== null) {
    loanNumbers.add(match[1].replace(/[-\s]/g, ''));
  }

  return [...loanNumbers];
}

function extractAddresses(text) {
  const pattern = /\b\d+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:St(?:reet)?|Ave(?:nue)?|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Way|Pl|Place)\.?(?:\s*,?\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)?(?:\s*,?\s*[A-Z]{2})?\b/gi;
  const addresses = new Set();
  let match;
  while ((match = pattern.exec(text)) !== null) {
    addresses.add(match[0].trim());
  }
  return [...addresses];
}

function extractDealNames(text) {
  const pattern = /\b(?:property|loan|deal)\s+(?:at|on|for|located at)\s+([^,\n]+)/gi;
  const names = new Set();
  let match;
  while ((match = pattern.exec(text)) !== null) {
    names.add(match[1].trim());
  }
  return [...names];
}

// --- Deal matching ---

function isTargetStage(deal) {
  return Object.values(TARGET_STAGES).includes(deal.properties.dealstage);
}

function scoreMatch(matchType, matchValue, deal, parsed) {
  let score = 0;

  if (matchType === 'loan_number') {
    score = 100;
  } else if (matchType === 'deal_name') {
    score = 90;
    const dealName = deal.properties.dealname || '';
    if (dealName.toLowerCase() === matchValue.toLowerCase()) score = 95;
  } else if (matchType === 'address') {
    score = 75;
    if (matchValue.length > 30) score += 5;
    const fullAddress = deal.properties.full_address || '';
    if (fullAddress.toLowerCase().includes(matchValue.toLowerCase())) score += 5;
  }

  // Bonus for multiple identifier matches
  const loanNumber = deal.properties.loan_number || '';
  const dealName = deal.properties.dealname || '';
  const fullAddress = deal.properties.full_address || '';
  let matchCount = 0;

  if (parsed.loanNumbers.some(ln => loanNumber.toLowerCase().includes(ln.toLowerCase()))) matchCount++;
  if (parsed.dealNames.some(dn => dealName.toLowerCase().includes(dn.toLowerCase()))) matchCount++;
  if (parsed.addresses.some(addr => fullAddress.toLowerCase().includes(addr.toLowerCase()))) matchCount++;

  if (matchCount > 1) score += (matchCount - 1) * 10;

  return Math.min(score, 100);
}

// --- HubSpot API calls ---

async function getEmail(apiKey, emailId) {
  return hubspotRequest(apiKey, `/crm/v3/objects/emails/${emailId}?properties=hs_email_subject,hs_email_text,hs_email_html,hs_timestamp`);
}

async function searchDealsByLoanNumber(apiKey, loanNumber, useServicerProperty = false) {
  const propertyName = useServicerProperty ? 'loan_number__servicer_' : 'loan_number';
  const data = await hubspotRequest(apiKey, '/crm/v3/objects/deals/search', {
    method: 'POST',
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName, operator: 'CONTAINS_TOKEN', value: loanNumber }] }],
      properties: ['loan_number', 'loan_number__servicer_', 'dealname', 'dealstage', 'full_address'],
      limit: 20
    })
  });
  return data.results || [];
}

async function searchDealsByField(apiKey, fieldName, value) {
  const data = await hubspotRequest(apiKey, '/crm/v3/objects/deals/search', {
    method: 'POST',
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: fieldName, operator: 'CONTAINS_TOKEN', value }] }],
      properties: ['dealname', 'loan_number', 'full_address', 'dealstage'],
      limit: 20
    })
  });
  return data.results || [];
}

async function getEmailContactAssociations(apiKey, emailId) {
  try {
    const data = await hubspotRequest(apiKey, `/crm/v4/objects/emails/${emailId}/associations/contacts`);
    return data.results || [];
  } catch (error) {
    if (error.message.includes('404')) return [];
    throw error;
  }
}

async function getContactDealAssociations(apiKey, contactId) {
  try {
    const data = await hubspotRequest(apiKey, `/crm/v4/objects/contacts/${contactId}/associations/deals`);
    return data.results || [];
  } catch (error) {
    if (error.message.includes('404')) return [];
    throw error;
  }
}

async function batchGetDeals(apiKey, dealIds) {
  const data = await hubspotRequest(apiKey, '/crm/v3/objects/deals/batch/read', {
    method: 'POST',
    body: JSON.stringify({
      properties: ['dealname', 'loan_number', 'full_address', 'dealstage'],
      inputs: dealIds.map(id => ({ id }))
    })
  });
  return data.results || [];
}

async function associateEmailToDeal(apiKey, emailId, dealId) {
  return hubspotRequest(apiKey, `/crm/v4/objects/emails/${emailId}/associations/deals/${dealId}`, {
    method: 'PUT',
    body: JSON.stringify([{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 210 }])
  });
}

// --- Main matching logic ---

async function findMatch(apiKey, parsed) {
  const candidates = [];

  // 1. Search by loan number (highest priority, 100% confidence)
  if (parsed.loanNumbers.length > 0) {
    for (const ln of parsed.loanNumbers) {
      const deals = await searchDealsByLoanNumber(apiKey, ln, parsed.hasServicer);
      const targetDeals = deals.filter(isTargetStage);
      if (targetDeals.length > 0) {
        // Loan number = 100% confidence, return immediately
        return { deal: targetDeals[0], confidence: 100, matchType: 'loan_number' };
      }
    }
  }

  // 2. Search by deal name (95% for exact match)
  if (parsed.dealNames.length > 0) {
    for (const name of parsed.dealNames) {
      await sleep(150);
      const deals = await searchDealsByField(apiKey, 'dealname', name);
      candidates.push(...deals.map(d => ({ deal: d, matchType: 'deal_name', matchValue: name })));
    }
  }

  // 3. Search by address
  if (parsed.addresses.length > 0) {
    for (const addr of parsed.addresses) {
      await sleep(150);
      const deals = await searchDealsByField(apiKey, 'full_address', addr);
      candidates.push(...deals.map(d => ({ deal: d, matchType: 'address', matchValue: addr })));
    }
  }

  // Score and pick best
  const scored = candidates
    .filter(c => isTargetStage(c.deal))
    .map(c => ({ ...c, score: scoreMatch(c.matchType, c.matchValue, c.deal, parsed) }))
    .sort((a, b) => b.score - a.score);

  if (scored.length > 0 && scored[0].score >= CONFIDENCE_THRESHOLD) {
    return { deal: scored[0].deal, confidence: scored[0].score, matchType: scored[0].matchType };
  }

  return null;
}

// Fallback: if the email's contact has exactly one deal, use it
async function fallbackSingleContactDeal(apiKey, emailId) {
  try {
    const contactAssocs = await getEmailContactAssociations(apiKey, emailId);
    if (contactAssocs.length === 0) return null;

    for (const assoc of contactAssocs) {
      const contactId = assoc.toObjectId;
      const dealAssocs = await getContactDealAssociations(apiKey, contactId);

      if (dealAssocs.length === 1) {
        const deals = await batchGetDeals(apiKey, [dealAssocs[0].toObjectId]);
        if (deals.length === 1) {
          console.log(`Fallback match: contact ${contactId} has exactly 1 deal (${deals[0].properties.dealname})`);
          return { deal: deals[0], confidence: 100, matchType: 'single_contact_deal' };
        }
      } else if (dealAssocs.length > 1) {
        console.log(`Fallback skip: contact ${contactId} has ${dealAssocs.length} deals`);
      }
    }

    return null;
  } catch (error) {
    console.error(`Fallback error: ${error.message}`);
    return null;
  }
}

// --- Main handler ---

export async function handler(event) {
  console.log('Email sync function triggered');

  // Handle GET requests (webhook verification)
  if (event.httpMethod === 'GET') {
    return { statusCode: 200, body: 'Email sync webhook active' };
  }

  // Handle POST requests (webhook events)
  if (event.httpMethod === 'POST') {
    try {
      const apiKey = process.env.HUBSPOT_API_KEY;
      if (!apiKey) {
        return { statusCode: 500, body: JSON.stringify({ error: 'HUBSPOT_API_KEY not configured' }) };
      }

      const events = JSON.parse(event.body);

      // Deduplicate: only process each email ID once per batch
      const seen = new Set();
      const uniqueEvents = events.filter(evt => {
        // Only process email events (objectTypeId 0-49)
        if (evt.objectTypeId !== '0-49') return false;

        // Only process on hs_email_direction change or creation
        if (evt.subscriptionType === 'object.propertyChange' && evt.propertyName !== 'hs_email_direction') {
          return false;
        }

        const key = String(evt.objectId);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      console.log(`Processing ${uniqueEvents.length} unique events (${events.length - uniqueEvents.length} filtered/dupes)`);

      const results = [];

      for (const evt of uniqueEvents) {
        const emailId = evt.objectId;

        try {
          console.log(`Processing email ${emailId}`);

          // Get email details
          const email = await getEmail(apiKey, emailId);
          const subject = email.properties.hs_email_subject || '';
          const body = email.properties.hs_email_text || email.properties.hs_email_html || '';

          // Parse email content
          const parsed = parseEmail(subject, body);
          console.log(`Parsed: ${parsed.loanNumbers.length} loan#, ${parsed.addresses.length} addr, ${parsed.dealNames.length} names`);

          // Try content-based matching
          let match = await findMatch(apiKey, parsed);

          // Fallback: single deal on contact
          if (!match) {
            match = await fallbackSingleContactDeal(apiKey, emailId);
          }

          if (match) {
            console.log(`Matched email ${emailId} to deal ${match.deal.properties.dealname} (${match.confidence}% via ${match.matchType})`);
            await associateEmailToDeal(apiKey, emailId, match.deal.id);
            results.push({
              emailId,
              dealId: match.deal.id,
              dealName: match.deal.properties.dealname,
              confidence: match.confidence,
              matchType: match.matchType,
              success: true
            });
          } else {
            console.log(`No match found for email ${emailId}`);
          }

          // Throttle between events
          await sleep(200);

        } catch (error) {
          console.error(`Error processing email ${emailId}: ${error.message}`);
        }
      }

      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, processed: results.length, results })
      };

    } catch (error) {
      console.error('Error processing webhook:', error);
      return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
  }

  return { statusCode: 405, body: 'Method not allowed' };
}
