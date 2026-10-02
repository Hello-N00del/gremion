// gremion-ui/src/routes/api/internal/push/+server.ts
// B4: FCM legacy HTTP API (fcm.googleapis.com/fcm/send + Authorization: key=) is dead since
// July 2024. This endpoint uses FCM HTTP v1 with a Google service account JSON for OAuth2.
import { json, error } from '@sveltejs/kit';
import { timingSafeEqual } from 'crypto';
import { GoogleAuth } from 'google-auth-library';
import type { RequestHandler } from './$types';

function safeCompare(a: string, b: string): boolean {
  try {
    // Pad to same length to prevent length-based timing leak
    const bufA = Buffer.from(a.padEnd(b.length));
    const bufB = Buffer.from(b.padEnd(a.length));
    // Use the longer length for both comparisons to be truly constant-time
    const len = Math.max(bufA.length, bufB.length);
    return timingSafeEqual(
      Buffer.concat([bufA], len),
      Buffer.concat([bufB], len)
    ) && a.length === b.length;
  } catch {
    return false;
  }
}

interface PushPayload {
  event: 'calendar_reminder' | 'poll_new' | 'poll_closing' | 'election_open' | 'election_closing';
  title: string;
  body: string;
  /** Keycloak user IDs to notify. Empty = all users. */
  user_ids?: string[];
  data?: Record<string, string>;
}

export const POST: RequestHandler = async ({ request }) => {
  // Verify shared secret — never expose this endpoint publicly
  const secret = request.headers.get('x-internal-secret');
  const expected = process.env.INTERNAL_PUSH_SECRET;
  if (!expected || !secret || !safeCompare(secret, expected)) {
    throw error(403, 'Forbidden');
  }

  let payload: PushPayload;
  try {
    payload = await request.json() as PushPayload;
  } catch {
    throw error(400, 'Invalid JSON');
  }

  if (!payload.event || !payload.title) {
    throw error(400, 'Missing required fields: event, title');
  }

  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) throw error(500, 'GOOGLE_SERVICE_ACCOUNT_JSON not configured');

  let credentials: Record<string, string>;
  try {
    credentials = JSON.parse(serviceAccountJson) as Record<string, string>;
  } catch {
    throw error(500, 'GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }

  const projectId = credentials['project_id'];
  if (!projectId) throw error(500, 'project_id missing from service account JSON');

  // Fetch FCM tokens for target users from Keycloak user attributes
  const tokens = await getFcmTokens(payload.user_ids ?? []);

  if (tokens.length === 0) {
    return json({ sent: 0, message: 'No registered devices' });
  }

  // Get OAuth2 access token using service account (FCM HTTP v1 requires Bearer token)
  const auth = new GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
  });
  const authClient = await auth.getClient();
  const tokenRes = await authClient.getAccessToken();
  const accessToken = tokenRes.token;
  if (!accessToken) throw error(500, 'Failed to obtain FCM access token');

  // FCM HTTP v1 sends one message per token
  let sent = 0;
  for (const token of tokens) {
    const fcmRes = await fetch(
      `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: payload.title, body: payload.body ?? '' },
            data: { event: payload.event, ...payload.data },
          },
        }),
      },
    );
    if (fcmRes.ok) sent++;
  }

  return json({ sent });
};

/** Stub — replace with real Keycloak user attribute lookup in production. */
async function getFcmTokens(userIds: string[]): Promise<string[]> {
  // TODO: query Keycloak Admin REST API for user attribute 'fcm_token'
  // filtered to userIds (or all users if empty)
  void userIds;
  return [];
}
