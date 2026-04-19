const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static('public'));

const DEFAULT_SOURCE = 'https://fcapi.amitbala1993.workers.dev/';

function universalParser(data) {
    let streams = [];
    const seenUrls = new Set();
    function findStreams(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach(val => findStreams(val)); return; }
        const streamKeywords = ['stream_url', 'url', 'link', 'm3u8', 'src', 'playback_url', 'live_url'];
        const urlKey = streamKeywords.find(key => {
            const val = obj[key];
            return val && typeof val === 'string' && (val.startsWith('http') || val.includes('.m3u8'));
        });
        if (urlKey) {
            const streamUrl = obj[urlKey];
            if (!seenUrls.has(streamUrl)) {
                seenUrls.add(streamUrl);
                const titleKeys = ['match', 'title', 'name', 'label', 'display_name', 'match_name', 'tournament'];
                const logoKeys = ['image', 'logo', 'thumb', 'poster', 'thumbnail', 'match_logo'];
                const catKeys = ['category', 'genre', 'group', 'type'];
                streams.push({
                    url: streamUrl,
                    name: obj[titleKeys.find(k => obj[k])] || 'Unknown Stream',
                    logo: obj[logoKeys.find(k => obj[k] && typeof obj[k] === 'string' && obj[k].startsWith('http'))] || '',
                    group: obj[catKeys.find(k => obj[k])] || 'General'
                });
            }
        }
        Object.values(obj).forEach(val => { if (val && typeof val === 'object') findStreams(val); });
    }
    findStreams(data);
    return streams;
}

function parseM3U(content) {
    const streams = [];
    const lines = content.split('\n');
    let currentStream = null;
    let pendingHeaders = {};
    let pendingDrm = {};
    lines.forEach(line => {
        line = line.trim();
        if (line.startsWith('#EXTINF:')) {
            const namePart = line.split(',').pop().trim();
            const logoMatch = line.match(/tvg-logo="([^"]+)"/);
            const groupMatch = line.match(/group-title="([^"]+)"/);
            currentStream = { name: namePart || 'Unknown Channel', logo: logoMatch ? logoMatch[1] : '', group: groupMatch ? groupMatch[1] : 'General', url: '', drm: null };
        } else if (line.startsWith('#EXTVLCOPT:')) {
            const opt = line.replace('#EXTVLCOPT:', '').split('=');
            if (opt.length >= 2) { pendingHeaders[opt[0].trim().replace('http-', '')] = opt.slice(1).join('=').trim(); }
        } else if (line.startsWith('#EXTHTTP:')) {
            try { Object.assign(pendingHeaders, JSON.parse(line.replace('#EXTHTTP:', ''))); } catch (e) {}
        } else if (line.startsWith('#KODIPROP:')) {
            const prop = line.replace('#KODIPROP:', '').split('=');
            if (prop.length >= 2) {
                const key = prop[0].trim(); const val = prop.slice(1).join('=').trim();
                if (key.includes('license_type')) pendingDrm.type = val;
                if (key.includes('license_key')) pendingDrm.key = val;
            }
        } else if (line.startsWith('http')) {
            let finalUrl = line;
            if (Object.keys(pendingHeaders).length > 0) {
                const b64Headers = Buffer.from(JSON.stringify(pendingHeaders)).toString('base64');
                finalUrl += `|b64:${b64Headers}`;
            }
            if (currentStream) {
                currentStream.url = finalUrl;
                if (Object.keys(pendingDrm).length > 0) currentStream.drm = { ...pendingDrm };
                streams.push(currentStream); currentStream = null;
            } else {
                streams.push({ name: 'Direct Stream', url: finalUrl, logo: '', group: 'General', drm: Object.keys(pendingDrm).length > 0 ? { ...pendingDrm } : null });
            }
            pendingHeaders = {}; pendingDrm = {};
        }
    });
    return streams;
}

const DEFAULT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Referer': 'https://www.hotstar.com/',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://www.hotstar.com'
};

function getHeadersFromPipe(pipePart) {
    const headers = { ...DEFAULT_HEADERS };
    if (!pipePart || pipePart === 'none') return headers;
    try {
        const cleaned = pipePart.replace(/^pipe=/, '').replace(/^b64:/, '');
        const jsonStr = Buffer.from(cleaned, 'base64').toString('utf-8');
        const jsonHeaders = JSON.parse(jsonStr);
        Object.entries(jsonHeaders).forEach(([k, v]) => {
            const lk = k.toLowerCase();
            if (lk === 'user-agent') headers['User-Agent'] = v;
            else if (lk === 'referer') headers['Referer'] = v;
            else if (lk === 'cookie') headers['Cookie'] = v;
            else if (lk === 'origin') headers['Origin'] = v;
            else headers[k] = v;
        });
    } catch (e) { console.warn('[PipeHeaders] Parse error:', e.message); }
    return headers;
}

app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    const pipe = req.query.pipe || 'none';
    if (!targetUrl) return res.status(400).send('URL required');
    const headers = getHeadersFromPipe(pipe);
    console.log(`[Proxy] Fetching: ${targetUrl.substring(0, 100)}...`);
    try {
        const response = await axios({ method: 'get', url: targetUrl, headers, responseType: 'arraybuffer', timeout: 25000, maxRedirects: 5 });
        let content = response.data;
        let contentType = (response.headers['content-type'] || '').toLowerCase();
        const targetBase = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        if (targetUrl.includes('.m3u8') || contentType.includes('mpegurl') || contentType.includes('m3u')) {
            let m3u8Text = content.toString('utf8');
            const processedLines = m3u8Text.split('\n').map(line => {
                const trimmed = line.trim();
                if (trimmed === '') return '';
                if (trimmed.startsWith('#')) {
                    return trimmed.replace(/URI="([^"]+)"/g, (match, p1) => {
                        const abs = p1.startsWith('http') ? p1 : new URL(p1, targetBase).href;
                        return `URI="${abs}"`;
                    });
                }
                return trimmed.startsWith('http') ? trimmed : new URL(trimmed, targetBase).href;
            });
            res.setHeader('Content-Type', 'application/x-mpegURL');
            return res.send(processedLines.join('\n'));
        }
        if (targetUrl.includes('.mpd') || contentType.includes('dash+xml') || contentType.includes('text/xml') || contentType.includes('application/xml')) {
            let xml = content.toString('utf8');
            if (!xml.includes('<BaseURL>')) {
                xml = xml.replace(/<MPD([^>]*)>/, `<MPD$1>\n  <BaseURL>${targetBase}</BaseURL>`);
            }
            res.setHeader('Content-Type', 'application/dash+xml');
            return res.send(xml);
        }
        res.setHeader('Content-Type', contentType || 'application/octet-stream');
        res.send(content);
    } catch (error) {
        console.error(`[Proxy Fail] ${targetUrl.substring(0, 80)}: ${error.message}`);
        res.status(error.response ? error.response.status : 500).send(error.message);
    }
});

app.get('/playlist', async (req, res) => {
    const rawUrl = req.query.url || DEFAULT_SOURCE;
    const parts = rawUrl.split('|');
    const baseUrl = parts[0];
    const headers = parts.length > 1 ? getHeadersFromPipe(parts[1]) : { ...DEFAULT_HEADERS };
    try {
        const response = await axios.get(baseUrl, { headers, timeout: 15000 });
        const streams = universalParser(response.data);
        let m3u8 = "#EXTM3U\n";
        streams.forEach((s, i) => { m3u8 += `#EXTINF:-1 tvg-id="s${i}" tvg-name="${s.name}" tvg-logo="${s.logo}" group-title="${s.group}", ${s.name}\n${s.url}\n\n`; });
        res.setHeader('Content-Type', 'application/x-mpegURL');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(m3u8);
    } catch (error) { res.status(500).send(`Error: ${error.message}`); }
});

app.get('/api/status', async (req, res) => {
    const rawUrl = req.query.url || DEFAULT_SOURCE;
    const parts = rawUrl.split('|');
    const baseUrl = parts[0];
    const headers = parts.length > 1 ? getHeadersFromPipe(parts[1]) : { ...DEFAULT_HEADERS };
    try {
        const response = await axios.get(baseUrl, { headers, timeout: 15000 });
        const streams = universalParser(response.data);
        res.json({ success: true, total: streams.length, streams });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/parse-m3u', async (req, res) => {
    if (!req.query.url) return res.status(400).json({ success: false, error: 'URL required' });
    try {
        const response = await axios.get(req.query.url, {
            headers: { ...DEFAULT_HEADERS, 'Accept': 'text/plain, */*' },
            timeout: 20000, maxRedirects: 10
        });
        let content = response.data;
        if (typeof content === 'object') {
            const streams = universalParser(content);
            return res.json({ success: true, total: streams.length, streams });
        }
        const streams = parseM3U(String(content));
        res.json({ success: true, total: streams.length, streams });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/scrape', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ success: false, error: 'URL required' });
    let browser;
    try {
        // Use system Chromium if available (Docker/Railway), else download
        const launchOptions = {
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        };
        if (process.env.PUPPETEER_EXECUTABLE_PATH) {
            launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
        }
        browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();
        await page.setUserAgent(DEFAULT_HEADERS['User-Agent']);
        const discoveredLinks = new Set();
        await page.setRequestInterception(true);
        page.on('request', interceptedReq => {
            const url = interceptedReq.url();
            if (url.includes('.m3u8') || url.includes('.mpd')) discoveredLinks.add(url);
            interceptedReq.continue();
        });
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        const selectors = ['button[aria-label="Play"]', '.play-button', 'video', '[class*="play"]'];
        for (const s of selectors) {
            try { const el = await page.$(s); if (el) { await el.click(); await new Promise(r => setTimeout(r, 4000)); break; } } catch (e) {}
        }
        await new Promise(r => setTimeout(r, 8000));
        const links = Array.from(discoveredLinks).map(l => ({ url: l, name: 'Scraped Stream', logo: '', group: l.includes('.mpd') ? 'DASH' : 'HLS' }));
        res.json({ success: true, count: links.length, streams: links, links });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
    finally { if (browser) await browser.close(); }
});

app.listen(PORT, () => { console.log(`✅ Server running at http://localhost:${PORT}`); });
