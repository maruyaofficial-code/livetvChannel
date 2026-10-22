import apiServerClient from '@/lib/apiServerClient';

/**
 * Live TV data layer supporting raw .m3u playlists & JSON APIs.
 */

const TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_PREFIX = 'livetv:v1:';

export const PROVIDERS = {
    Cignal: { path: '/cignal.m3u' },
    Converge: { path: '/converge.m3u' },
};
export const PROVIDER_NAMES = Object.keys(PROVIDERS);

const memoryCache = new Map();
const inflight = new Map();

/**
 * Parses raw M3U text (including Kodi #KODIPROP ClearKey DRM) into structured objects.
 */
export function parseM3U(m3uText, providerName) {
    const lines = m3uText.split(/\r?\n/);
    const channels = [];
    const seenIds = new Set();

    let current = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        if (line.startsWith('#EXTINF:')) {
            current = {
                name: '',
                tvgId: '',
                logo: '',
                group: 'Other',
                url: '',
                clearkey: null,
                source: providerName,
            };

            const tvgIdMatch = line.match(/tvg-id="([^"]*)"/i);
            if (tvgIdMatch) current.tvgId = tvgIdMatch[1];

            const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
            if (logoMatch) current.logo = logoMatch[1];

            const groupMatch = line.match(/group-title="([^"]*)"/i);
            if (groupMatch) current.group = groupMatch[1];

            const commaIdx = line.lastIndexOf(',');
            if (commaIdx !== -1) {
                current.name = line.substring(commaIdx + 1).trim();
            }
        } else if (line.startsWith('#KODIPROP:inputstream.adaptive.license_key=')) {
            const keyVal = line.replace('#KODIPROP:inputstream.adaptive.license_key=', '').trim();
            const parts = keyVal.split(':');
            if (parts.length === 2 && current) {
                current.clearkey = {
                    kid: parts[0].trim(),
                    key: parts[1].trim(),
                };
            }
        } else if (!line.startsWith('#')) {
            if (current) {
                current.url = line;
                if (current.name && current.url) {
                    let id = `${providerName}:${current.tvgId || current.name}`;
                    let count = 0;
                    while (seenIds.has(id)) {
                        count++;
                        id = `${providerName}:${current.tvgId || current.name}#${count}`;
                    }
                    seenIds.add(id);

                    channels.push({
                        ...current,
                        id,
                    });
                }
                current = null;
            }
        }
    }

    return {
        channels,
        groups: Array.from(new Set(channels.map((c) => c.group))),
    };
}

const readSession = (name) => {
    try {
        const raw = sessionStorage.getItem(CACHE_PREFIX + name);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
};

const writeSession = (name, entry) => {
    try {
        sessionStorage.setItem(CACHE_PREFIX + name, JSON.stringify(entry));
    } catch { /* storage quota fallback */ }
};

const getCached = (name) => {
    const entry = memoryCache.get(name) || readSession(name);
    if (!entry) return null;
    memoryCache.set(name, entry);
    return entry;
};

const fetchWithTimeout = async (path) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        return await apiServerClient.fetch(path, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
};

const requestPlaylist = async (name) => {
    const { path } = PROVIDERS[name];
    let lastErr;

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const res = await fetchWithTimeout(path);
            if (!res.ok) {
                const err = new Error(`${name} request failed (${res.status})`);
                err.status = res.status;
                if (res.status < 500) throw Object.assign(err, { fatal: true });
                throw err;
            }

            const contentType = res.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                const data = await res.json();
                return {
                    channels: (data.channels || []).map((c, i) => ({
                        ...c,
                        id: `${name}:${c.tvgId || c.name}#${i}`,
                        source: name,
                    })),
                    groups: data.groups || [],
                };
            }

            // Parse raw M3U text
            const text = await res.text();
            return parseM3U(text, name);
        } catch (err) {
            lastErr = err.name === 'AbortError' ? new Error(`${name} request timed out`) : err;
            if (err.fatal) break;
            await new Promise((r) => setTimeout(r, 600));
        }
    }

    const stale = getCached(name);
    if (stale) return stale.data;

    throw lastErr;
};

const attachSignal = (promise, signal) => {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason || new Error('Aborted'));
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason || new Error('Aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (res) => { signal.removeEventListener('abort', onAbort); resolve(res); },
            (err) => { signal.removeEventListener('abort', onAbort); reject(err); }
        );
    });
};

export async function getProviderChannels(name, { force = false, signal } = {}) {
    if (!PROVIDERS[name]) throw new Error(`Unknown provider: ${name}`);

    if (!force) {
        const cached = getCached(name);
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;
    }

    let p;
    if (inflight.has(name) && !force) {
        p = inflight.get(name);
    } else {
        p = requestPlaylist(name)
            .then((data) => {
                const entry = { at: Date.now(), data };
                memoryCache.set(name, entry);
                writeSession(name, entry);
                return data;
            })
            .finally(() => inflight.delete(name));

        inflight.set(name, p);
    }

    return attachSignal(p, signal);
}

export const getLiveChannels = (opts) => getProviderChannels('Cignal', opts);
export const getConvergeChannels = (opts) => getProviderChannels('Converge', opts);

export function clearLiveTVCache() {
    memoryCache.clear();
    PROVIDER_NAMES.forEach((n) => {
        try { sessionStorage.removeItem(CACHE_PREFIX + n); } catch { /* noop */ }
    });
}
