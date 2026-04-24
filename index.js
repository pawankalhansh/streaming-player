const express = require('express');
const axios = require('axios');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.static('public'));

const DEFAULT_SOURCE = 'https://fcapi.amitbala1993.workers.dev/';

const HEADER_PROFILES = {
    fancode: { 'User-Agent': '@allinonereborn_links', 'Referer': 'https://fancode.com/', 'Origin': 'https://fancode.com', 'Accept': '*/*' },
    default: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36', 'Referer': 'https://www.google.com/', 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9' }
};

function getHeadersForUrl(url, pipePart) {
    let headers = url && url.includes('fancode.com') ? { ...HEADER_PROFILES.fancode } : { ...HEADER_PROFILES.default };
    if (pipePart && pipePart !== 'none') {
        try {
            const cleaned = pipePart.replace(/^pipe=/, '').replace(/^b64:/, '');
            const jsonStr = Buffer.from(cleaned, 'base64').toString('utf-8');
            Object.entries(JSON.parse(jsonStr)).forEach(([k, v]) => {
                const lk = k.toLowerCase();
                if (lk === 'user-agent') headers['User-Agent'] = v;
                else if (lk === 'referer') headers['Referer'] = v;
                else if (lk === 'cookie') headers['Cookie'] = v;
                else if (lk === 'origin') headers['Origin'] = v;
                else headers[k] = v;
            });
        } catch (e) {}
    }
    return headers;
}

function universalParser(data) {
    const streams = [];
    const seenUrls = new Set();
    const sourceHeaders = (data && typeof data === 'object' && !Array.isArray(data) && data.headers) ? data.headers : {};
    function findStreams(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach(findStreams); return; }
        const streamKeywords = ['stream_url', 'url', 'link', 'm3u8', 'src', 'playback_url', 'live_url'];
        const urlKey = streamKeywords.find(k => { const v = obj[k]; return v && typeof v === 'string' && (v.startsWith('http') || v.includes('.m3u8')); });
        if (urlKey) {
            const rawUrl = obj[urlKey];
            if (!seenUrls.has(rawUrl)) {
                seenUrls.add(rawUrl);
                let finalUrl = rawUrl;
                if (Object.keys(sourceHeaders).length > 0) finalUrl += `|b64:${Buffer.from(JSON.stringify(sourceHeaders)).toString('base64')}`;
                const titleKeys = ['match', 'title', 'name', 'label', 'display_name', 'match_name', 'tournament'];
                const logoKeys = ['image', 'logo', 'thumb', 'poster', 'thumbnail', 'match_logo'];
                const catKeys = ['category', 'genre', 'group', 'type'];
                streams.push({
                    url: finalUrl,
                    name: obj[titleKeys.find(k => obj[k] && typeof obj[k] === 'string')] || 'Unknown Stream',
                    logo: obj[logoKeys.find(k => obj[k] && typeof obj[k] === 'string' && obj[k].startsWith('http'))] || '',
                    group: obj[catKeys.find(k => obj[k] && typeof obj[k] === 'string')] || 'General',
                });
            }
        }
        Object.values(obj).forEach(v => { if (v && typeof v === 'object') findStreams(v); });
    }
    findStreams(data);
    return streams;
}

function parseM3U(content) {
    const streams = []; const lines = content.split('\n'); let cur = null, pH = {}, pD = {};
    lines.forEach(line => {
        line = line.trim();
        if (line.startsWith('#EXTINF:')) { cur = { name: line.split(',').pop().trim() || 'Unknown', logo: (line.match(/tvg-logo="([^"]+)"/) || [])[1] || '', group: (line.match(/group-title="([^"]+)"/) || [])[1] || 'General', url: '', drm: null }; }
        else if (line.startsWith('#EXTVLCOPT:')) { const o = line.replace('#EXTVLCOPT:', '').split('='); if (o.length >= 2) pH[o[0].trim().replace('http-', '')] = o.slice(1).join('=').trim(); }
        else if (line.startsWith('#EXTHTTP:')) { try { Object.assign(pH, JSON.parse(line.replace('#EXTHTTP:', ''))); } catch (e) {} }
        else if (line.startsWith('#KODIPROP:')) { const p = line.replace('#KODIPROP:', '').split('='); if (p.length >= 2) { if (p[0].includes('license_type')) pD.type = p.slice(1).join('=').trim(); if (p[0].includes('license_key')) pD.key = p.slice(1).join('=').trim(); } }
        else if (line.startsWith('http')) {
            let finalUrl = line;
            if (Object.keys(pH).length > 0) finalUrl += `|b64:${Buffer.from(JSON.stringify(pH)).toString('base64')}`;
            if (cur) { cur.url = finalUrl; if (Object.keys(pD).length > 0) cur.drm = { ...pD }; streams.push(cur); cur = null; }
            else streams.push({ name: 'Direct Stream', url: finalUrl, logo: '', group: 'General', drm: Object.keys(pD).length > 0 ? { ...pD } : null });
            pH = {}; pD = {};
        }
    });
    return streams;
}

app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url; const pipe = req.query.pipe || 'none';
    if (!targetUrl) return res.status(400).send('URL required');
    const headers = getHeadersForUrl(targetUrl, pipe);
    console.log(`[Proxy] ${targetUrl.substring(0, 90)}`);
    try {
        const resp = await axios({ method: 'get', url: targetUrl, headers, responseType: 'arraybuffer', timeout: 25000, maxRedirects: 10 });
        const content = resp.data; const ct = (resp.headers['content-type'] || '').toLowerCase();
        const base = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (targetUrl.includes('.m3u8') || ct.includes('mpegurl') || ct.includes('m3u')) {
            const lines = content.toString('utf8').split('\n').map(line => {
                const t = line.trim(); if (!t) return '';
                if (t.startsWith('#')) return t.replace(/URI="([^"]+)"/g, (_, p) => `URI="${p.startsWith('http') ? p : new URL(p, base).href}"`);
                return t.startsWith('http') ? t : new URL(t, base).href;
            });
            res.setHeader('Content-Type', 'application/x-mpegURL'); return res.send(lines.join('\n'));
        }
        if (targetUrl.includes('.mpd') || ct.includes('dash') || ct.includes('xml')) {
            let xml = content.toString('utf8');
            // Make all relative BaseURL tags absolute
            xml = xml.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, function(match, p1) {
                if (p1.startsWith('http')) return match;
                try { return '<BaseURL>' + new URL(p1, base).href + '</BaseURL>'; }
                catch(e) { return match; }
            });
            // If no BaseURL at all, inject at Period level
            if (!xml.includes('<BaseURL>')) {
                xml = xml.replace(/<Period([^>]*)>/, '<Period$1><BaseURL>' + base + '</BaseURL>');
            }
            res.setHeader('Content-Type', 'application/dash+xml');
            res.setHeader('Access-Control-Allow-Origin', '*');
            return res.send(xml);
        }
        res.setHeader('Content-Type', ct || 'application/octet-stream'); res.send(content);
    } catch (e) { console.error(`[Proxy Fail] ${e.message}`); res.status(e.response ? e.response.status : 500).send(e.message); }
});

app.get('/playlist', async (req, res) => {
    const rawUrl = req.query.url || DEFAULT_SOURCE; const [baseUrl, pipe] = rawUrl.split('|');
    try {
        const resp = await axios.get(baseUrl, { headers: getHeadersForUrl(baseUrl, pipe), timeout: 15000 });
        const streams = universalParser(resp.data);
        let m3u = '#EXTM3U\n';
        streams.forEach((s, i) => { m3u += `#EXTINF:-1 tvg-id="s${i}" tvg-name="${s.name}" tvg-logo="${s.logo}" group-title="${s.group}", ${s.name}\n${s.url}\n\n`; });
        res.setHeader('Content-Type', 'application/x-mpegURL'); res.setHeader('Access-Control-Allow-Origin', '*'); res.send(m3u);
    } catch (e) { res.status(500).send(`Error: ${e.message}`); }
});

app.get('/api/status', async (req, res) => {
    const rawUrl = req.query.url || DEFAULT_SOURCE; const [baseUrl, pipe] = rawUrl.split('|');
    try {
        const resp = await axios.get(baseUrl, { headers: getHeadersForUrl(baseUrl, pipe), timeout: 15000 });
        const streams = universalParser(resp.data);
        res.json({ success: true, total: streams.length, streams });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/parse-m3u', async (req, res) => {
    if (!req.query.url) return res.status(400).json({ success: false, error: 'URL required' });
    try {
        const headers = { ...HEADER_PROFILES.default, 'Accept': 'text/plain, */*' };
        const resp = await axios.get(req.query.url, { headers, timeout: 20000, maxRedirects: 10 });
        const content = resp.data;
        if (typeof content === 'object') return res.json({ success: true, total: 0, streams: universalParser(content) });
        const streams = parseM3U(String(content));
        res.json({ success: true, total: streams.length, streams });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/scrape', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ success: false, error: 'URL required' });
    let browser;
    try {
        const opts = { headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] };
        if (process.env.PUPPETEER_EXECUTABLE_PATH) opts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
        browser = await puppeteer.launch(opts);
        const page = await browser.newPage();
        await page.setUserAgent(HEADER_PROFILES.default['User-Agent']);
        const found = new Set();
        await page.setRequestInterception(true);
        page.on('request', r => { const u = r.url(); if (u.includes('.m3u8') || u.includes('.mpd')) found.add(u); r.continue(); });
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        for (const s of ['button[aria-label="Play"]', '.play-button', 'video', '[class*="play"]']) {
            try { const el = await page.$(s); if (el) { await el.click(); await new Promise(r => setTimeout(r, 4000)); break; } } catch (e) {}
        }
        await new Promise(r => setTimeout(r, 8000));
        const links = Array.from(found).map(l => ({ url: l, name: 'Scraped Stream', logo: '', group: l.includes('.mpd') ? 'DASH' : 'HLS' }));
        res.json({ success: true, count: links.length, streams: links, links });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    finally { if (browser) await browser.close(); }
});

// DRM Key Proxy — fetches key server-side to avoid CORS
app.get('/api/drm-key', async (req, res) => {
    const keyUrl = req.query.url;
    if (!keyUrl) return res.status(400).json({ error: 'URL required' });
    try {
        const response = await axios.get(keyUrl, {
            headers: { ...HEADER_PROFILES.default },
            timeout: 10000
        });
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');
        res.json(response.data);
    } catch (e) {
        console.error('[DRM Key Error]', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
