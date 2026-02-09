/**
 * Netlify Function: Email Sync Stats
 * Returns statistics about email syncing
 */

export async function handler(event) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      status: 'active',
      message: 'Email sync integration running on Netlify',
      stages: ['presentationscheduled', 'closedwon', '4447566']
    })
  };
}
