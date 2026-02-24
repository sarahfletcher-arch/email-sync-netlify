/**
 * Netlify Function: Email Sync Webhook
 * Handles HubSpot webhook events for email sync
 *
 * Features:
 * - Deduplicates events within a batch
 * - Retries with backoff on rate limits (429)
 * - Matches by loan number (incl. 9-digit servicer numbers), address, and deal name
 * - 65% confidence threshold (address matches score 80+)
 * - Subject line pattern extraction (draws, payments, title work)
 * - Cross-field search (dealname <-> full_address fallback)
 * - Fallback: if contact has exactly one deal, assumes that's the match
 * - Throttles API calls to stay within HubSpot limits
 */

import fetch from 'node-fetch';

// HubSpot API base URL
const HUBSPOT_API_BASE = 'https://api.hubapi.com';

// Target deal stages - any active/funded deal stage
const TARGET_STAGES = {
  processing: 'presentationscheduled',
  postFunded: 'closedwon',
  sold: '4447566',
  repaid: '4447567',
  lienReleased: '1085330955',
  dscrProcessing: '1067972413',
  dscrPostCloseQC: '1067972416',
  dscrClosedWon: '1269293461',
  preForeclosure: '1015819060',
  foreclosureActive: '1015819061',
  foreclosurePaused: '1018320194',
  foreclosureAuction: '1018320195',
  reoPreListing: '1015819063',
  reoListed: '1018320196',
  reoUnderContract: '1018320197',
};
const TARGET_STAGE_VALUES = new Set(Object.values(TARGET_STAGES));

// Minimum confidence to auto-associate
const CONFIDENCE_THRESHOLD = 65;

// Address false-positive blacklist
const ADDRESS_BLACKLIST = [
  /^\d+\s+(am|pm|quick|other|of\b)/i,
  /bankruptcy|unsubscribe|copyright/i,
  /^\d+\s+\w+\s+to\s+get\s+started/i,
];

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
  const cleanSubject = (subject || '').trim();
  const cleanBody = (body || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  return {
    loanNumbers: extractLoanNumbers(cleanSubject, cleanBody),
    addresses: extractAddresses(cleanSubject, cleanBody),
    dealNames: extractDealNames(cleanSubject, cleanBody),
  };
}

function extractLoanNumbers(subject, body) {
  const text = `${subject}\n${body}`;
  const loanNumbers = new Set();

  // BF-YYYY-NNNN format
  const bfPattern = /\b(BF[-\s]?\d{4}[-\s]?\d{4})\b/gi;
  let match;
  while ((match = bfPattern.exec(text)) !== null) {
    const normalized = match[1].replace(/[-\s]/g, '');
    loanNumbers.add(`BF-${normalized.substring(2, 6)}-${normalized.substring(6)}`);
  }

  // Numeric loan numbers with context (5-10 digits)
  // e.g., "loan number 399536679", "file 5260113979", "Loan number 399536679"
  const numPattern = /\b(?:loans?|deals?|files?|documents?)\s*(?:number|#|no\.?|num\.?)?\s*:?\s*[-–]?\s*(\d{5,10})\b/gi;
  while ((match = numPattern.exec(text)) !== null) {
    loanNumbers.add(match[1]);
  }

  // Servicer loan numbers in subject (7-10 digits after separator)
  // e.g., "RECORDED DOCUMENTS - 399558497", "Raikin/5260113979"
  const subjectPattern = /(?:[-–|/]\s*)(\d{7,10})\b/g;
  while ((match = subjectPattern.exec(subject)) !== null) {
    loanNumbers.add(match[1]);
  }

  return [...loanNumbers];
}

function cleanAddress(raw) {
  if (!raw) return null;
  let addr = raw.split('\n')[0].split('\r')[0].trim();
  addr = addr.replace(/[.\s]+$/, '').trim();
  if (addr.length < 6) return null;
  if (ADDRESS_BLACKLIST.some(p => p.test(addr))) return null;
  return addr;
}

function extractAddresses(subject, body) {
  const addresses = new Set();
  const addrPattern = /\b(\d{1,6}\s+(?:[A-Za-z]{2,}\.?\s+){1,4}(?:St(?:reet)?|Ave(?:nue)?|Rd|Road|Dr(?:ive)?|Ln|Lane|Blvd|Boulevard|Ct|Court|Way|Pl(?:ace)?|Cir(?:cle)?|Pkwy|Parkway|Ter(?:race)?|Trl|Trail|Hwy|Highway)\.?)(?:[\s,]+(?:(?:Apt|Suite|Ste|Unit|#)\.?\s*[A-Za-z0-9-]+))?(?:\s*,\s*([A-Za-z]+(?:\s+[A-Za-z]+)*)\s*,?\s*([A-Z]{2}))?(?:\s+(\d{5}(?:-\d{4})?))?/g;

  // Process body line by line to prevent cross-line matching
  for (const line of body.split('\n')) {
    const cleanLine = line.trim();
    if (!cleanLine) continue;
    let match;
    while ((match = addrPattern.exec(cleanLine)) !== null) {
      const addr = cleanAddress(match[0]);
      if (addr) addresses.add(addr);
    }
  }

  // Check subject line
  let match;
  while ((match = addrPattern.exec(subject)) !== null) {
    const addr = cleanAddress(match[0]);
    if (addr) addresses.add(addr);
  }

  // Extract address from subject separators (e.g., "Title Work | 708 Pallister, Detroit, MI")
  const subjectAddrMatch = subject.match(/[|:–-]\s*(\d{1,6}\s+[A-Za-z][\w\s]+?(?:,\s*[A-Za-z]+(?:\s+[A-Za-z]+)*)?(?:,\s*[A-Z]{2})?(?:\s+\d{5})?)\s*$/);
  if (subjectAddrMatch) {
    const addr = cleanAddress(subjectAddrMatch[1]);
    if (addr && addr.length > 5) addresses.add(addr);
  }

  return [...addresses];
}

function extractDealNames(subject, body) {
  const names = new Set();

  // Subject line patterns: "Draw 6 - 168 Las Palmas", "PAYMENTS: 21 Valley Rd"
  const subjectPattern = /(?:draw\s*\d*\s*[-–]\s*|payments?:\s*|title\s+work\s*[|]\s*|desktop\s+for\s+)(.+?)(?:\s*[-–|]\s*|$)/gi;
  let match;
  while ((match = subjectPattern.exec(subject)) !== null) {
    const name = match[1].trim();
    if (name.length >= 3 && name.length <= 80) names.add(name);
  }

  // Property references in body
  const text = `${subject}\n${body}`;
  const refPattern = /\b(?:property|loan|deal)\s+(?:at|on|for|located at)\s+(.+?)(?:\s+(?:has|have|was|were|is|will|shall|can|should|and|but|or|which|that)\b|[,.\n]|$)/gi;
  while ((match = refPattern.exec(text)) !== null) {
    const name = match[1].trim();
    if (name.length >= 3 && name.length <= 60 && !name.includes('\n')) names.add(name);
  }

  return [...names];
}

// --- Deal matching ---

function isTargetStage(deal) {
  return TARGET_STAGE_VALUES.has(deal.properties.dealstage);
}

function cleanSearchValue(value) {
  if (!value) return '';
  return value.split('\n')[0].split('\r')[0].replace(/\s+/g, ' ').replace(/[.]+$/, '').trim();
}

function extractStreetCore(address) {
  const beforeComma = address.split(',')[0].trim();
  const withoutSuffix = beforeComma.replace(
    /\s+(?:St(?:reet)?|Ave(?:nue)?|Rd|Road|Dr(?:ive)?|Ln|Lane|Blvd|Boulevard|Ct|Court|Way|Pl(?:ace)?|Cir(?:cle)?|Pkwy|Ter(?:race)?|Trl|Hwy)\.?\s*$/i,
    ''
  ).trim();
  if (/^\d+\s+\w+/.test(withoutSuffix)) return withoutSuffix;
  return beforeComma;
}

function scoreMatch(matchType, matchValue, deal, parsed) {
  let score = 0;
  const cleanMatch = (matchValue || '').split('\n')[0].trim().toLowerCase();

  if (matchType === 'loan_number') {
    score = 100;
  } else if (matchType === 'deal_name') {
    score = 85;
    const dealName = (deal.properties.dealname || '').toLowerCase();
    if (dealName === cleanMatch) score = 95;
    else if (dealName.includes(cleanMatch)) score = 90;
  } else if (matchType === 'address') {
    score = 80;
    const fullAddress = (deal.properties.full_address || '').toLowerCase();
    const dealName = (deal.properties.dealname || '').toLowerCase();
    const streetNum = cleanMatch.match(/^(\d+)/);
    if (streetNum && (fullAddress.includes(streetNum[1]) || dealName.includes(streetNum[1]))) {
      score += 5;
    }
    if (cleanMatch.length > 25) score += 5;
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

async function searchDealsByLoanNumber(apiKey, loanNumber) {
  // Search across loan_number, servicer A-piece, and servicer B-piece fields
  const data = await hubspotRequest(apiKey, '/crm/v3/objects/deals/search', {
    method: 'POST',
    body: JSON.stringify({
      filterGroups: [
        { filters: [{ propertyName: 'loan_number', operator: 'CONTAINS_TOKEN', value: loanNumber }] },
        { filters: [{ propertyName: 'loan_number__servicer_', operator: 'CONTAINS_TOKEN', value: loanNumber }] },
        { filters: [{ propertyName: 'loan_number__b_piece_servicer_', operator: 'CONTAINS_TOKEN', value: loanNumber }] },
      ],
      properties: ['loan_number', 'loan_number__servicer_', 'loan_number__b_piece_servicer_', 'dealname', 'dealstage', 'full_address'],
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
      const deals = await searchDealsByLoanNumber(apiKey, ln);
      const targetDeals = deals.filter(isTargetStage);
      if (targetDeals.length > 0) {
        return { deal: targetDeals[0], confidence: 100, matchType: 'loan_number' };
      }
    }
  }

  // 2. Search by deal name, with fallback to full_address
  if (parsed.dealNames.length > 0) {
    for (const name of parsed.dealNames) {
      const cleanName = cleanSearchValue(name);
      if (!cleanName || cleanName.length < 3) continue;
      await sleep(150);
      let deals = await searchDealsByField(apiKey, 'dealname', cleanName);
      if (deals.length === 0) {
        deals = await searchDealsByField(apiKey, 'full_address', cleanName);
      }
      candidates.push(...deals.map(d => ({ deal: d, matchType: 'deal_name', matchValue: cleanName })));
    }
  }

  // 3. Search by address, with fallback to dealname
  if (parsed.addresses.length > 0) {
    for (const addr of parsed.addresses) {
      const cleanAddr = cleanSearchValue(addr);
      if (!cleanAddr || cleanAddr.length < 5) continue;
      const streetPart = extractStreetCore(cleanAddr);
      await sleep(150);
      let deals = await searchDealsByField(apiKey, 'full_address', streetPart || cleanAddr);
      if (deals.length === 0) {
        deals = await searchDealsByField(apiKey, 'dealname', streetPart || cleanAddr);
      }
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
