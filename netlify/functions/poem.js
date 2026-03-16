// Netlify Serverless Function — proxy ke Groq API
// Fitur: cache per menit (hemat token), rotasi API key, prompt di server

const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join('/tmp', 'poem-cache.json');

// ─── Cache helpers ────────────────────────────────────────────────────────────
function loadCache() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        }
    } catch { }
    return {};
}

function saveCache(cache) {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8');
    } catch { }
}

function cleanOldEntries(cache) {
    const now = Date.now();
    const MAX_AGE = 2 * 60 * 1000; // 2 menit
    for (const key of Object.keys(cache)) {
        if (now - cache[key].ts > MAX_AGE) {
            delete cache[key];
        }
    }
    return cache;
}

// ─── Prompt builder ───────────────────────────────────────────────────────────
function buildPrompt(h, m, hari) {
    const jam = parseInt(h);
    const waktu = jam < 4 ? 'dini hari' : jam < 11 ? 'pagi' : jam < 15 ? 'siang' : jam < 18 ? 'sore' : 'malam';

    const suasanaMap = {
        'dini hari': 'sunyi mencekam, dunia tidur, hanya pikiran yang terjaga',
        'pagi': 'cahaya pertama menyentuh bumi, dunia mulai bernapas',
        'siang': 'matahari tegak lurus, bayangan menyusut, panas menekan',
        'sore': 'cahaya melemah, langit berubah warna, hari bersiap pergi',
        'malam': 'gelap menyelimuti, lampu-lampu menyala, pikiran mulai mengembara'
    };
    const suasana = suasanaMap[waktu] || '';

    return `Tulis puisi 4 baris tentang pukul ${h}:${m} ${waktu} hari ${hari}.

Suasana: ${suasana}.

Contoh puisi yang bagus:

Pukul tiga dini hari menjahit kelopak mataku
dengan benang-benang sesal yang tak kunjung putus
bantal ini menyimpan jejak air mata bisu
dan gelap masih menolak datangnya fajar di pelupuk

Pukul tujuh lewat dua puluh membangunkan debu di rak buku
secangkir kopi mendingin bersama janji yang kau tinggalkan
matahari masuk lewat celah jendela yang retak hatinya
pagi ini berat seperti surat yang tak pernah terkirim

Pukul sembilan malam menggantung di langit-langit kamar
kudengar jam dinding berdebat dengan kebisuan lorong
bayangan di cermin lebih jujur dari semua kata-katamu
malam ini aku meminjam sunyi untuk bicara sendiri

Sekarang tulis puisi baru untuk pukul ${h}:${m} ${waktu}. Ingat:
- Tepat 4 baris saja
- Gunakan metafora — jangan tulis secara harfiah
- Buat pembaca merasakan suasana waktu itu
- HANYA tulis 4 baris puisi, tanpa judul, tanpa penjelasan`;
}

// ─── Post-processing ──────────────────────────────────────────────────────────
function cleanPoem(raw) {
    const lines = raw
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .filter(l => !l.startsWith('#') && !l.startsWith('*') && !l.startsWith('>') && !l.startsWith('---'))
        .map(l => l.replace(/^\d+[.)]\s*/, ''))
        .map(l => l.replace(/^["'"""'']+|["'"""'']+$/g, ''))
        .filter(l => l.length > 10)
        .slice(0, 4);

    if (lines.length < 2) return null;
    return lines.join('\n');
}

// ─── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    // Ambil API keys dari environment variables
    const API_KEYS = [
        process.env.GROQ_KEY_1,
        process.env.GROQ_KEY_2,
        process.env.GROQ_KEY_3,
        process.env.GROQ_KEY_4,
        process.env.GROQ_KEY_5,
    ].filter(Boolean);

    if (API_KEYS.length === 0) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Tidak ada API key dikonfigurasi' }) };
    }

    let body;
    try {
        body = JSON.parse(event.body);
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const { h, m, hari } = body;
    if (!h || !m || !hari) {
        return { statusCode: 400, body: JSON.stringify({ error: 'h, m, hari wajib diisi' }) };
    }

    // ─── Cek cache: jika menit ini sudah ada puisi, langsung kembalikan ───
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const cacheKey = `${today}-${h}:${m}`;

    let cache = loadCache();
    cache = cleanOldEntries(cache);

    if (cache[cacheKey]) {
        console.log(`📦 Cache hit: ${cacheKey}`);
        saveCache(cache);
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ poem: cache[cacheKey].poem, cached: true })
        };
    }

    // ─── Generate puisi baru ──────────────────────────────────────────────────
    console.log(`✨ Generating: ${cacheKey}`);
    const prompt = buildPrompt(h, m, hari);

    let lastError = null;
    for (let i = 0; i < API_KEYS.length; i++) {
        try {
            const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${API_KEYS[i]}`
                },
                body: JSON.stringify({
                    model: 'llama-3.3-70b-versatile',
                    max_tokens: 200,
                    temperature: 0.65,
                    top_p: 0.85,
                    frequency_penalty: 0.3,
                    presence_penalty: 0.4,
                    messages: [
                        {
                            role: 'system',
                            content: 'Kamu penyair Indonesia bergaya Sapardi Djoko Damono. Kamu menulis puisi pendek yang padat metafora, penuh imaji indrawi, dan menyentuh perasaan. Setiap puisimu tepat 4 baris. Kamu HANYA membalas dengan 4 baris puisi tanpa judul atau penjelasan apapun.'
                        },
                        { role: 'user', content: prompt }
                    ]
                })
            });

            if (res.status === 429 || res.status === 500 || res.status === 503) {
                console.log(`Key #${i + 1} kena limit (${res.status}), coba berikutnya...`);
                lastError = `Key #${i + 1}: HTTP ${res.status}`;
                continue;
            }

            if (!res.ok) {
                lastError = `HTTP ${res.status}`;
                continue;
            }

            const data = await res.json();
            const raw = data.choices?.[0]?.message?.content?.trim();
            if (!raw) { lastError = 'respons kosong'; continue; }

            const poem = cleanPoem(raw);
            if (!poem) { lastError = 'puisi tidak valid'; continue; }

            // Simpan ke cache
            cache[cacheKey] = { poem, ts: Date.now() };
            saveCache(cache);

            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ poem, cached: false })
            };

        } catch (err) {
            lastError = err.message;
            continue;
        }
    }

    return {
        statusCode: 502,
        body: JSON.stringify({ error: `Semua API key gagal: ${lastError}` })
    };
};
