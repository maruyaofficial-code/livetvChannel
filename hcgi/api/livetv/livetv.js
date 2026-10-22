import { Router } from 'express';
import { Readable } from 'node:stream';

const router = Router();

const CIGNAL_PLAYLIST_URL = 'https://maruyatvph.com/cignal.m3u';
const CONVERGE_PLAYLIST_URL = 'https://maruyatvph.com/converge.m3u';

// Node.js 18+ is required for built-in fetch() and Readable.fromWeb().
const asyncRoute = (handler) => (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);

const sendUpstreamError = (res, message, status = 502) => {
    if (res.headersSent) {
        res.destroy();
        return;
    }
    res.status(status).json({ error: message });
};

function validateHttpUrl(raw, label = 'URL') {
    let parsed;
    try {
        parsed = new URL(String(raw));
    } catch {
        throw new Error(`${label} is not a valid URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`${label} must use HTTP or HTTPS`);
    }
    if (parsed.username || parsed.password) {
        throw new Error(`${label} must not contain embedded credentials`);
    }
    return parsed;
}

const decodeXml = (s) =>
    s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");

const xmlEscape = (s) =>
    s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

// Keep Shaka template variables ($Time$, $Number$, etc.) literal.
const encodeSeg = (s) => encodeURIComponent(s).replace(/%24/g, '$');

function parsePlaylist(text) {
    const lines = text.split(/\r?\n/);
    const channels = [];
    let current = null;
    let pendingProps = {};

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith('#EXTINF')) {
            const commaIdx = line.indexOf(',');
            const name = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : '';
            const attrsPart = commaIdx >= 0 ? line.slice(0, commaIdx) : line;
            const tvgId = (attrsPart.match(/tvg-id="([^"]*)"/) || [])[1] || '';
            const tvgLogo = (attrsPart.match(/tvg-logo="([^"]*)"/) || [])[1] || '';
            const groupTitle =
                (attrsPart.match(/group-title="([^"]*)"/) || [])[1] || 'Other';

            current = {
                name,
                tvgId,
                logo: tvgLogo,
                group: groupTitle,
                url: '',
                clearkey: null,
            };
            pendingProps = {};
        } else if (line.startsWith('#KODIPROP:')) {
            const body = line.slice('#KODIPROP:'.length);
            const eqIdx = body.indexOf('=');
            if (eqIdx < 0) continue;
            pendingProps[body.slice(0, eqIdx).trim()] = body.slice(eqIdx + 1).trim();
        } else if (!line.startsWith('#') && current) {
            current.url = line;

            if (pendingProps['inputstream.adaptive.license_type'] === 'clearkey') {
                const license = pendingProps['inputstream.adaptive.license_key'] || '';
                const splitAt = license.indexOf(':');
                if (splitAt > 0) {
                    current.clearkey = {
                        kid: license.slice(0, splitAt).trim(),
                        key: license.slice(splitAt + 1).trim(),
                    };
                }
            }

            channels.push(current);
            current = null;
            pendingProps = {};
        }
    }
    return channels;
}

function groupsFrom(channels) {
    return [...new Set(channels.map((c) => c.group || 'Other'))]
        .sort((a, b) => a.localeCompare(b));
}

async function fetchText(url, label) {
    validateHttpUrl(url, label);
    const upstream = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
    });

    if (!upstream.ok) {
        throw new Error(`${label} failed: HTTP ${upstream.status} ${upstream.statusText}`);
    }
    return { upstream, text: await upstream.text() };
}

// GET /hcgi/api/livetv/playlist
router.get('/playlist', asyncRoute(async (_req, res) => {
    const { text } = await fetchText(CIGNAL_PLAYLIST_URL, 'Cignal playlist fetch');
    const channels = parsePlaylist(text).map((c) => ({ ...c, source: 'Cignal' }));
    res.set('Cache-Control', 'no-store');
    res.json({ channels, groups: groupsFrom(channels) });
}));

// GET /hcgi/api/livetv/converge/playlist
router.get('/converge/playlist', asyncRoute(async (_req, res) => {
    const { text } = await fetchText(CONVERGE_PLAYLIST_URL, 'Converge playlist fetch');
    const channels = parsePlaylist(text).map((c) => ({
        ...c,
        source: 'Converge',
        // Browser loads our same-origin proxy, not the original HTTP stream.
        url: `/hcgi/api/livetv/converge/stream?u=${encodeURIComponent(c.url)}`,
        // This proxy does not expose upstream DRM keys.
        clearkey: null,
    }));
    res.set('Cache-Control', 'no-store');
    res.json({ channels, groups: groupsFrom(channels) });
}));

// GET /hcgi/api/livetv/converge/stream?u=<original MPD URL>
router.get('/converge/stream', asyncRoute(async (req, res) => {
    const rawUrl = req.query.u;
    if (typeof rawUrl !== 'string' || !rawUrl) {
        return res.status(422).json({ error: 'u query param (original manifest URL) is required' });
    }

    validateHttpUrl(rawUrl, 'Manifest URL');
    const upstream = await fetch(rawUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
    });

    if (!upstream.ok) {
        return sendUpstreamError(
            res,
            `Converge manifest fetch failed: HTTP ${upstream.status} ${upstream.statusText}`,
        );
    }

    const finalUrl = upstream.url || rawUrl;
    validateHttpUrl(finalUrl, 'Final manifest URL');

    // SegmentTemplate URLs are resolved against the final redirected manifest.
    const baseUrl = new URL('.', finalUrl).href;
    const xml = await upstream.text();

    const rewritten = xml.replace(
        /\b(media|initialization)="([^"]*)"/g,
        (_match, attr, rawValue) => {
            const raw = decodeXml(rawValue);
            const proxyUrl =
                `/hcgi/api/livetv/converge/segment?base=${encodeURIComponent(baseUrl)}&seg=${encodeSeg(raw)}`;
            return `${attr}="${xmlEscape(proxyUrl)}"`;
        },
    );

    res.status(200);
    res.set('Content-Type', 'application/dash+xml; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(rewritten);
}));

// GET /hcgi/api/livetv/converge/segment?base=<origin directory>&seg=<template/path>
router.get('/converge/segment', asyncRoute(async (req, res) => {
    const base = req.query.base;
    const seg = req.query.seg;

    if (typeof base !== 'string' || typeof seg !== 'string' || !base || !seg) {
        return res.status(422).json({ error: 'base and seg query params are required' });
    }

    validateHttpUrl(base, 'Segment base URL');

    // Resolve relative paths while preserving Shaka's literal template variables.
    const fullUrl = new URL(seg, base).href;
    validateHttpUrl(fullUrl, 'Segment URL');

    const upstream = await fetch(fullUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
    });

    if (!upstream.ok) {
        return sendUpstreamError(
            res,
            `Converge segment fetch failed: HTTP ${upstream.status} ${upstream.statusText}`,
        );
    }

    res.status(200);
    res.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    res.set('Cache-Control', 'no-store');
    res.set('Access-Control-Allow-Origin', '*');

    if (!upstream.body) {
        return res.end();
    }

    Readable.fromWeb(upstream.body).on('error', () => {
        if (!res.headersSent) res.status(502);
        res.destroy();
    }).pipe(res);
}));

// JSON error handler for errors thrown by the async routes above.
router.use((err, _req, res, _next) => {
    console.error('[livetv proxy]', err);
    sendUpstreamError(res, err?.message || 'Proxy request failed', 502);
});

export default router;
