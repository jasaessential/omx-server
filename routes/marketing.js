/* ═══════════════════════════════════════════════
   JASA V2 — Marketing push route
   POST /api/marketing/send-push
     Auth: Firebase ID token of a user with the 'admin' or 'manage_marketing' role.
     Body: { title, body, image?, link?, tokens: [fcmToken, ...] }
     ← { success, successCount, failureCount, totalTokens, invalidTokens, errors }

   Same contract as the Worker's /api/send-push-all, but sends through the
   server's shared firebase-admin app (server/firebase.js). The admin page
   uses it when the Worker has no FIREBASE_SERVICE_ACCOUNT secret, so pushes
   work with the credentials the rest of the server already uses.
   ═══════════════════════════════════════════════ */
'use strict';

const express = require('express');
const { db, admin } = require('../firebase');
const { verifyUser } = require('../authHelpers');

const router = express.Router();

const SITE      = 'https://ordermyxerox.com';
const ICON      = `${SITE}/assets/logo.png`;
const MAX_TOKENS = 5000;
const STALE_CODES = new Set([
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
    'messaging/invalid-argument',
]);

async function verifyMarketer(req, res) {
    const user = await verifyUser(req, res);
    if (!user) return null;
    const snap  = await db.collection('users').doc(user.uid).get();
    const d     = snap.exists ? snap.data() : {};
    const roles = d.roles || [d.role || 'user'];
    if (!roles.includes('admin') && !roles.includes('manage_marketing')) {
        res.status(403).json({ error: 'Admin or marketing access required.' });
        return null;
    }
    return user;
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isHttpUrl = v => /^https?:\/\//i.test(v);

router.post('/send-push', async (req, res) => {
    const user = await verifyMarketer(req, res);
    if (!user) return;

    const title = str(req.body?.title, 100);
    const body  = str(req.body?.body, 300);
    const image = str(req.body?.image, 1000);
    let   link  = str(req.body?.link, 1000);
    if (!title || !body) return res.status(400).json({ error: 'Missing title or body' });
    if (link && !isHttpUrl(link)) link = `${SITE}/${link.replace(/^\/+/, '')}`;
    if (!link) link = `${SITE}/`;

    const tokens = [...new Set((Array.isArray(req.body?.tokens) ? req.body.tokens : [])
        .filter(t => typeof t === 'string' && t.length > 20 && t.length < 4096))].slice(0, MAX_TOKENS);
    if (!tokens.length) return res.status(400).json({ error: 'No tokens provided' });

    const useImage = image && isHttpUrl(image) ? image : undefined;
    let successCount = 0, failureCount = 0;
    const invalidTokens = [], errors = [];

    try {
        for (let i = 0; i < tokens.length; i += 500) {
            const chunk = tokens.slice(i, i + 500);
            const out = await admin.messaging().sendEachForMulticast({
                tokens: chunk,
                notification: { title, body, ...(useImage ? { imageUrl: useImage } : {}) },
                webpush: {
                    notification: { icon: ICON, ...(useImage ? { image: useImage } : {}) },
                    fcmOptions:   { link },
                },
            });
            successCount += out.successCount;
            failureCount += out.failureCount;
            out.responses.forEach((r, j) => {
                if (r.success) return;
                const code = r.error?.code || '';
                if (STALE_CODES.has(code)) invalidTokens.push(chunk[j]);
                if (errors.length < 10) errors.push({ token: chunk[j].slice(0, 20) + '...', error: code || r.error?.message || 'failed' });
            });
        }
    } catch (err) {
        console.error('[marketing] send failed:', err.code || err.message);
        return res.status(500).json({ error: 'Could not send through Firebase. Check the server Firebase credentials.' });
    }

    try {
        await db.collection('sent_notifications').add({
            title, body, image: useImage || null, link,
            recipientCount: tokens.length,
            successCount, failureCount,
            sent_at: new Date().toISOString(),
            sentBy: user.uid,
            via: 'server',
            status: 'success',
        });
    } catch (e) { console.error('[marketing] history log failed:', e.message); }

    res.json({ success: true, successCount, failureCount, totalTokens: tokens.length, invalidTokens, errors });
});

module.exports = router;
