/* ═══════════════════════════════════════════════
   JASA V2 — server/routes/files.js
   Customer files (xerox documents, poster photos) in the PRIVATE Cloudflare R2
   bucket "omx-customer-files" (moved from Supabase Storage 2026-11-21).
   Browsers never get an R2 key: this route holds it and hands out short-lived
   presigned URLs after checking who is asking.

   Stored links did not change. Orders keep the old Supabase-style link
   (`https://<ref>.supabase.co/storage/v1/object/public/files/<path>`) and new
   uploads get the same form, so no order data or browser code had to change.
   The link is only an ID now; this route maps it to an R2 key:
     current project (FILE_LINK_BASE)  …/files/<path>  → R2 key <path>
     any older project <ref>           …/files/<path>  → R2 key legacy/<ref>/<path>

   POST /api/files/upload-url  { kind: 'xerox' | 'poster' | 'order', name, orderId? }
        → { uploadUrl, fileUrl }   PUT the file body to uploadUrl; store fileUrl.
   POST /api/files/view-url    { orderId, url }   or (admin)  { path }
        → { url }  signed for 15 min. Allowed for the order's customer, admins,
          and sellers / employees of the order's shop (same as firestore.rules).
   POST /api/files/view-urls   { orderId, urls: [...] }
        → { urls: { [storedLink]: signedUrl } }   same check, one call per order page.
   GET  /api/files/list?prefix=     (admin)  → { files: [{ name, fullPath, created_at, metadata }] }
   POST /api/files/delete  { paths } (admin) → { deleted }

   Env: R2_ACCOUNT_ID, R2_FILES_ACCESS_KEY_ID, R2_FILES_SECRET_ACCESS_KEY (secret —
        an R2 token with Object Read & Write on the files bucket),
        R2_FILES_BUCKET (default omx-customer-files),
        FILE_LINK_BASE (default the Supabase project the links were made with).
   ═══════════════════════════════════════════════ */
'use strict';

const express = require('express');
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { r2RequestHandler } = require('../r2-handler');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { db } = require('../firebase');
const { verifyUser, verifyAdmin, sendError, fail } = require('../authHelpers');

const router = express.Router();

const VIEW_TTL_S   = 15 * 60;
const UPLOAD_TTL_S = 2 * 60 * 60;   // big PDFs on slow phones
const LINK_BASE = () => (process.env.FILE_LINK_BASE || 'https://tujxcpohmnprbxoyiyat.supabase.co').replace(/\/+$/, '');
const BUCKET    = () => process.env.R2_FILES_BUCKET || 'omx-customer-files';

let _r2;
function r2() {
    if (_r2) return _r2;
    const accountId = process.env.R2_ACCOUNT_ID;
    const keyId  = process.env.R2_FILES_ACCESS_KEY_ID;
    const secret = process.env.R2_FILES_SECRET_ACCESS_KEY;
    if (!accountId || !keyId || !secret) throw new Error('R2_ACCOUNT_ID / R2_FILES_ACCESS_KEY_ID / R2_FILES_SECRET_ACCESS_KEY not configured');
    _r2 = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: keyId, secretAccessKey: secret },
        ...r2RequestHandler(),
    });
    return _r2;
}
const filesConfigured = () => !!(process.env.R2_ACCOUNT_ID && process.env.R2_FILES_ACCESS_KEY_ID && process.env.R2_FILES_SECRET_ACCESS_KEY);

const signGet = key => getSignedUrl(r2(), new GetObjectCommand({ Bucket: BUCKET(), Key: key }), { expiresIn: VIEW_TTL_S });

const encPath   = p => p.split('/').map(encodeURIComponent).join('/');
const cleanName = n => String(n || 'file').replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(-120) || 'file';
const safeId    = s => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);
const badPath   = p => !p || p.split('/').some(seg => !seg || seg === '..' || seg === '.');

/** Object path for a link into the CURRENT project (FILE_LINK_BASE) — this is
    also the R2 key; null for anything else, including links into old projects. */
function pathFromUrl(url) {
    const u = String(url || '');
    if (u.startsWith('http') && !u.startsWith(`${LINK_BASE()}/`)) return null;
    const m = u.match(/\/storage\/v1\/object\/(?:public\/|sign\/|authenticated\/)?files\/([^?#]+)/);
    if (!m) return null;
    let p;
    try { p = decodeURIComponent(m[1]); } catch { return null; }
    return badPath(p) ? null : p;
}

/* Orders placed before 2026-10-08 link to an older Supabase project (public
   bucket). Files copied from there live in R2 under legacy/<ref>/<path>; until
   a file is copied (or if that project is gone) its public link is returned
   as before. */
const LEGACY_FILE_URL = /^https:\/\/([a-z0-9]+)\.supabase\.co\/storage\/v1\/object\/public\/files\/([^\s"'<>?#]+)$/;
function legacyKey(url) {
    const m = String(url || '').match(LEGACY_FILE_URL);
    if (!m) return null;
    let p;
    try { p = decodeURIComponent(m[2]); } catch { return null; }
    return badPath(p) ? null : `legacy/${m[1]}/${p}`;
}

async function inR2(key) {
    try { await r2().send(new HeadObjectCommand({ Bucket: BUCKET(), Key: key })); return true; }
    catch { return false; }
}

/** R2 key for any stored link, or null. */
const keyForLink = url => pathFromUrl(url) || legacyKey(url);

/** The canonical link stored on orders (an ID, not fetchable by itself). */
const fileUrlFor = path => `${LINK_BASE()}/storage/v1/object/public/files/${encPath(path)}`;

async function rolesOf(uid) {
    const s = await db.collection('users').doc(uid).get();
    const d = s.exists ? s.data() : {};
    return d.roles || [d.role || 'user'];
}

/** Mirrors the orders read rule: owner, admin, or seller/employee of the order's shop. */
async function canReadOrder(uid, order) {
    if (order.userId === uid) return true;
    const roles = await rolesOf(uid);
    if (roles.includes('admin')) return true;
    if (!roles.includes('seller') && !roles.includes('employee')) return false;
    if (!order.shopId) return false;
    const shop = await db.collection('shops').doc(String(order.shopId)).get();
    const sd = shop.exists ? shop.data() : {};
    return (sd.owners || []).includes(uid) || (sd.employees || []).includes(uid);
}

/** Every file link on an order (xerox documents, custom poster and poster wall photos). */
function orderFileLinks(order) {
    return new Set([
        ...(order.documents || []).map(d => d?.uploadedUrl),
        ...(order.items || []).map(i => i?.customPhoto),
        ...(order.items || []).map(i => i?.customPreview),
        ...(order.items || []).flatMap(i => (Array.isArray(i?.wallSlots) ? i.wallSlots : []).map(s => s?.photo)),
    ].filter(Boolean));
}

router.post('/upload-url', async (req, res) => {
    const user = await verifyUser(req, res);
    if (!user) return;
    try {
        const { kind, name, orderId } = req.body || {};
        const file = `${Date.now()}_${cleanName(name)}`;
        let path;
        if (kind === 'xerox')       path = `xerox-uploads/${user.uid}/${file}`;
        else if (kind === 'poster') path = `poster-uploads/${user.uid}/${file}`;
        else if (kind === 'order') {
            const id = safeId(orderId);
            const snap = id && await db.collection('orders').doc(id).get();
            if (!snap || !snap.exists || snap.data().userId !== user.uid) fail('Order not found.');
            path = `xerox-orders/${id}/${file}`;
        } else fail('Invalid upload type.');

        // Content-Type is left out of the signature: browsers send their own.
        const uploadUrl = await getSignedUrl(r2(), new PutObjectCommand({ Bucket: BUCKET(), Key: path }), { expiresIn: UPLOAD_TTL_S });
        res.json({ uploadUrl, fileUrl: fileUrlFor(path) });
    } catch (err) { sendError(res, err, 'files/upload-url'); }
});

/** Signed links for some of an order's file links, after the order read check.
    → { [storedLink]: openableUrl }; links that aren't on the order are left out. */
async function signOrderLinks(uid, orderId, urls) {
    const id = safeId(orderId);
    const snap = id && await db.collection('orders').doc(id).get();
    if (!snap || !snap.exists) fail('File not found.');
    const order = snap.data();
    if (!(await canReadOrder(uid, order))) fail('File not found.');

    const onOrder = orderFileLinks(order);
    const out = {};
    await Promise.all([...new Set(urls)].map(async url => {
        if (!onOrder.has(url)) return;
        const path = pathFromUrl(url);
        if (path) { out[url] = await signGet(path); return; }   // presigning is local, no network call
        const lkey = legacyKey(url);
        if (!lkey) return;
        out[url] = (await inR2(lkey)) ? await signGet(lkey) : url;
    }));
    return out;
}

router.post('/view-url', async (req, res) => {
    const user = await verifyUser(req, res);
    if (!user) return;
    try {
        const { orderId, url, path: rawPath } = req.body || {};
        if (!rawPath) {
            const link = url && (await signOrderLinks(user.uid, orderId, [url]))[url];
            if (!link) fail('File not found.');
            return res.json({ url: link });
        }
        // Admin storage browser — no order context
        if (!(await rolesOf(user.uid)).includes('admin')) fail('File not found.');
        const path = String(rawPath).replace(/^\/+/, '');
        if (badPath(path)) fail('File not found.');
        res.json({ url: await signGet(path) });
    } catch (err) { sendError(res, err, 'files/view-url'); }
});

/* Every file link on an order page at once, so the page can put openable links
   in place of the stored ones (which are IDs, not fetchable). */
router.post('/view-urls', async (req, res) => {
    const user = await verifyUser(req, res);
    if (!user) return;
    try {
        const { orderId, urls } = req.body || {};
        if (!Array.isArray(urls) || !urls.length || urls.length > 200) fail('Choose 1–200 files.');
        res.json({ urls: await signOrderLinks(user.uid, orderId, urls.map(String)) });
    } catch (err) { sendError(res, err, 'files/view-urls'); }
});

/* ── Admin storage browser (admin-cloud.html) ── */
router.get('/list', async (req, res) => {
    if (!(await verifyAdmin(req, res))) return;
    try {
        let prefix = String(req.query.prefix || '').replace(/^\/+/, '');
        if (prefix && !prefix.endsWith('/')) prefix += '/';
        const files = [];
        let token;
        do {
            const page = await r2().send(new ListObjectsV2Command({ Bucket: BUCKET(), Prefix: prefix || undefined, ContinuationToken: token, MaxKeys: 1000 }));
            for (const o of page.Contents || []) {
                files.push({ name: o.Key.split('/').pop(), fullPath: o.Key,
                             created_at: o.LastModified ? new Date(o.LastModified).toISOString() : null,
                             metadata: { size: o.Size } });
            }
            token = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (token && files.length < 20000);
        files.sort((a, b) => a.fullPath.localeCompare(b.fullPath));
        res.json({ files });
    } catch (err) { sendError(res, err, 'files/list'); }
});

router.post('/delete', async (req, res) => {
    if (!(await verifyAdmin(req, res))) return;
    try {
        const paths = (req.body?.paths || []).map(p => String(p || '').replace(/^\/+/, '')).filter(p => !badPath(p));
        if (!paths.length || paths.length > 500) fail('Choose 1–500 files.');
        const out = await r2().send(new DeleteObjectsCommand({
            Bucket: BUCKET(), Delete: { Objects: paths.map(Key => ({ Key })), Quiet: false },
        }));
        res.json({ deleted: (out.Deleted || []).length });
    } catch (err) { sendError(res, err, 'files/delete'); }
});

module.exports = { router, pathFromUrl, keyForLink, filesConfigured };
