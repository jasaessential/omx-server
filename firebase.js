/* ═══════════════════════════════════════════════
   JASA V2 — Firebase Admin SDK Initialization
   Credentials come from environment variables.
   NEVER hardcode keys here.
   ═══════════════════════════════════════════════ */
'use strict';

const admin = require('firebase-admin');

/* Credentials, in order of preference:
   1. FIREBASE_SERVICE_ACCOUNT (or FIREBASE_SERVICE_ACCOUNT_JSON) — the whole
      service-account JSON file, either raw or base64-encoded.
   2. The split vars FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL /
      FIREBASE_PRIVATE_KEY (+ optional _KEY_ID / _CLIENT_ID). The private key
      may hold real newlines or escaped "\\n" sequences, with or without quotes. */
function fromJsonVar() {
    const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
    if (!raw) return null;
    try {
        const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
        const sa = JSON.parse(text);
        if (sa.private_key) sa.private_key = String(sa.private_key).replace(/\\n/g, '\n');
        return sa;
    } catch (_) {
        console.error('[firebase] FIREBASE_SERVICE_ACCOUNT is set but is not valid JSON / base64 JSON — falling back to split vars.');
        return null;
    }
}

function fromSplitVars() {
    const key = (process.env.FIREBASE_PRIVATE_KEY || '').trim().replace(/^"|"$/g, '').replace(/\\n/g, '\n');
    return {
        type:                        'service_account',
        project_id:                  process.env.FIREBASE_PROJECT_ID,
        private_key_id:              process.env.FIREBASE_PRIVATE_KEY_ID,
        private_key:                 key,
        client_email:                process.env.FIREBASE_CLIENT_EMAIL,
        client_id:                   process.env.FIREBASE_CLIENT_ID,
        auth_uri:                    'https://accounts.google.com/o/oauth2/auth',
        token_uri:                   'https://oauth2.googleapis.com/token',
        auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
        client_x509_cert_url:        `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(process.env.FIREBASE_CLIENT_EMAIL || '')}`,
    };
}

if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(fromJsonVar() || fromSplitVars()) });
}

const db = admin.firestore();

/* ── Exported helpers ── */

/** Verify a Firebase ID token (from the browser's auth.currentUser.getIdToken()) */
async function verifyIdToken(idToken) {
    return admin.auth().verifyIdToken(idToken);
}

/** Get the Firestore instance */
function getDb() {
    return db;
}

module.exports = { admin, db, verifyIdToken, getDb };
