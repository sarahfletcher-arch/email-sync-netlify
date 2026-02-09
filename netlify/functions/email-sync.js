/**
 * Netlify Function: Email Sync Webhook
 * Handles HubSpot webhook events for email sync
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

// Email parser
function parseEmail(subject, body) {
  const text = `${subject || ''}\n${body || ''}`;
  const loanNumbers = [];

  // Check if email contains servicer keywords
  const hasServicer = /\b(FCI|GLS)\b/i.test(text);

  // Extract loan numbers - different patterns for servicer vs regular
  let loanPattern;
  if (hasServicer) {
    // For FCI/GLS emails: allow longer loan numbers (5-10 digits)
    loanPattern = /\b(?:loans?|deals?)\s*(?:number|#|no\.?|num\.?)?\s*:?\s*(\d{5,10})\b/gi;
  } else {
    // For regular emails: 5-6 digits only to avoid false positives
    loanPattern = /\b(?:loans?|deals?)\s*(?:number|#|no\.?|num\.?)?\s*:?\s*(\d{5,6})\b/gi;
  }

  let match;
  while ((match = loanPattern.exec(text)) !== null) {
    loanNumbers.push(match[1]);
  }

  // Extract from subject line after RE:/FW:
  const lines = text.split('\n');
  if (lines.length > 0) {
    const subjectPattern = hasServicer
      ? /\b(?:RE:|FW:)\s*(\d{5,10})\b/gi  // Longer numbers for servicer emails
      : /\b(?:RE:|FW:)\s*(\d{5,6})\b/gi;  // Standard 5-6 digits for regular
    while ((match = subjectPattern.exec(lines[0])) !== null) {
      loanNumbers.push(match[1]);
    }
  }

  return {
    loanNumbers: [...new Set(loanNumbers)],
    hasLoanNumber: loanNumbers.length > 0,
    hasServicer: hasServicer
  };
}

// Search deals by loan number
async function searchDeals(apiKey, loanNumber, useServicerProperty = false) {
  const propertyName = useServicerProperty ? 'loan_number__servicer_' : 'loan_number';

  const response = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/deals/search`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      filterGroups: [{
        filters: [{
          propertyName: propertyName,
          operator: 'CONTAINS_TOKEN',
          value: loanNumber
        }]
      }],
      properties: ['loan_number', 'loan_number__servicer_', 'dealname', 'dealstage'],
      limit: 20
    })
  });

  if (!response.ok) {
    throw new Error(`HubSpot API error: ${response.statusText}`);
  }

  const data = await response.json();
  return data.results || [];
}

// Check if deal is in target stage
function isTargetStage(deal) {
  const stage = deal.properties.dealstage;
  return Object.values(TARGET_STAGES).includes(stage);
}

// Get email details
async function getEmail(apiKey, emailId) {
  const response = await fetch(
    `${HUBSPOT_API_BASE}/crm/v3/objects/emails/${emailId}?properties=hs_email_subject,hs_email_text`,
    {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch email: ${response.statusText}`);
  }

  return await response.json();
}

// Associate email to deal
async function associateEmailToDeal(apiKey, emailId, dealId) {
  const response = await fetch(
    `${HUBSPOT_API_BASE}/crm/v4/objects/emails/${emailId}/associations/deals/${dealId}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([{
        associationCategory: "HUBSPOT_DEFINED",
        associationTypeId: 210
      }])
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to associate: ${response.statusText}`);
  }

  return await response.json();
}

// Main handler
export async function handler(event) {
  console.log('Email sync function triggered');

  // Handle GET requests (webhook verification)
  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      body: 'Email sync webhook active'
    };
  }

  // Handle POST requests (webhook events)
  if (event.httpMethod === 'POST') {
    try {
      const apiKey = process.env.HUBSPOT_API_KEY;

      if (!apiKey) {
        return {
          statusCode: 500,
          body: JSON.stringify({ error: 'HUBSPOT_API_KEY not configured' })
        };
      }

      const events = JSON.parse(event.body);
      console.log(`Processing ${events.length} events`);

      const results = [];

      for (const evt of events) {
        const emailId = evt.objectId;
        const objectTypeId = evt.objectTypeId;
        const eventType = evt.subscriptionType;

        // Only process email events
        if (objectTypeId !== '0-49') {
          console.log(`Skipping non-email event: ${eventType}`);
          continue;
        }

        // Only process on hs_email_direction change or creation
        if (eventType === 'object.propertyChange' && evt.propertyName !== 'hs_email_direction') {
          continue;
        }

        console.log(`Processing email ${emailId}`);

        // Get email details
        const email = await getEmail(apiKey, emailId);
        const subject = email.properties.hs_email_subject || '';
        const body = email.properties.hs_email_text || '';

        // Parse email
        const parsed = parseEmail(subject, body);

        if (!parsed.hasLoanNumber) {
          console.log(`No loan number found in email ${emailId}`);
          continue;
        }

        console.log(`Found loan numbers: ${parsed.loanNumbers.join(', ')}`);
        if (parsed.hasServicer) {
          console.log('Email contains FCI or GLS - searching by loan_number__servicer_');
        }

        // Search for matching deals
        for (const loanNumber of parsed.loanNumbers) {
          const deals = await searchDeals(apiKey, loanNumber, parsed.hasServicer);
          const targetDeals = deals.filter(isTargetStage);

          if (targetDeals.length > 0) {
            const deal = targetDeals[0];
            console.log(`Matched to deal: ${deal.properties.dealname}`);

            // Associate email to deal
            await associateEmailToDeal(apiKey, emailId, deal.id);

            results.push({
              emailId,
              dealId: deal.id,
              dealName: deal.properties.dealname,
              success: true
            });

            break; // Found a match, stop searching
          }
        }
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          processed: results.length,
          results
        })
      };

    } catch (error) {
      console.error('Error processing webhook:', error);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: error.message })
      };
    }
  }

  return {
    statusCode: 405,
    body: 'Method not allowed'
  };
}
