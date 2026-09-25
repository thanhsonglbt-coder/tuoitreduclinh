// tệp: /api/_lib.js — THƯ VIỆN DÙNG CHUNG (không phải API)
// Vercel không biến các tệp bắt đầu bằng dấu "_" thành API, nên tệp này chỉ để các API khác dùng chung.
// Gồm: (1) Bộ lọc từ khóa – LỚP 1, (2) AI phân loại – LỚP 2, (3) Kết hợp + theo dõi cả cuộc trò chuyện,
//      (4) Kết nối AI Groq, (5) Kết nối cơ sở dữ liệu Upstash Redis, (6) Kiến thức riêng của trường.

/* =====================================================================
   PHẦN 1. CHUẨN HÓA VĂN BẢN (bỏ dấu, teencode, ký tự lặp)
   ===================================================================== */
export function removeDiacritics(s) {
    return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
}

// Một số teencode phổ biến -> từ chuẩn (đã bỏ dấu)
const TEENCODE = [
    [/\b(k|ko|kh|kg|khg|hok|hong|hem|khum|kô)\b/g, "khong"],
    [/\b(j|ji)\b/g, "gi"],
    [/\b(dc|dk|duoc)\b/g, "duoc"],
    [/\b(mk|mik|mjk|mjnh|mh)\b/g, "minh"],
    [/\b(bt|bik|bjk|bit)\b/g, "biet"],
    [/\b(ng)\b/g, "nguoi"],
    [/\b(cx|cug)\b/g, "cung"],
    [/\b(vs)\b/g, "voi"],
    [/\b(r)\b/g, "roi"],
    [/\b(mun|mog)\b/g, "muon"],
    [/\b(chit|chek)\b/g, "chet"],
    [/\b(sog)\b/g, "song"],
    [/\b(ms)\b/g, "moi"],
    [/\b(ntn)\b/g, "nhu the nao"]
];

// Bản "không dấu" đã chuẩn hóa: dùng cho đa số từ khóa
export function normalizePlain(text) {
    let s = removeDiacritics(String(text || "").toLowerCase());
    s = s.replace(/[^a-z0-9\s]/g, " ");        // bỏ dấu câu, emoji
    s = s.replace(/([a-z])\1{2,}/g, "$1");      // "chetttt" -> "chet"
    for (const [re, rep] of TEENCODE) s = s.replace(re, rep);
    return " " + s.replace(/\s+/g, " ").trim() + " ";
}

// Bản "có dấu" (chữ thường): dùng cho từ khóa dễ nhầm khi bỏ dấu (vd "tự tử" ≠ "từ từ", "tự vẫn" ≠ "tư vấn")
export function normalizeAccent(text) {
    const s = String(text || "").toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}\s]/gu, " ");
    return " " + s.replace(/\s+/g, " ").trim() + " ";
}

/* =====================================================================
   PHẦN 2. LỚP 1 – BỘ TỪ ĐIỂN TỪ KHÓA CÓ TRỌNG SỐ
   Mức: 0 bình thường · 1 căng thẳng nhẹ · 2 đáng lo ngại · 3 khẩn cấp
   plain: viết KHÔNG DẤU · accent: viết CÓ DẤU (chỉ khớp khi học sinh gõ có dấu)
   ===================================================================== */
export const LEXICON = {
    3: {
        plain: [
            "tu sat", "muon chet", "khong muon song", "chan song", "het muon song",
            "ket thuc cuoc doi", "ket thuc cuoc song", "ket thuc tat ca", "ket lieu",
            "nhay cau", "nhay lau", "nhay song", "cat tay", "rach tay", "cat co tay",
            "treo co", "uong thuoc ngu", "uong thuoc chuot", "uong thuoc tu",
            "tu lam dau", "tu lam hai", "tu hai ban than", "tu huy",
            "khong con ly do de song", "chet di cho xong", "chet cho xong",
            "muon bien mat mai mai", "khong muon ton tai", "song khong co y nghia",
            "tam biet the gioi", "thu tuyet menh", "ngu mai khong day"
        ],
        accent: ["tự tử", "tự vẫn", "quyên sinh"]
    },
    2: {
        plain: [
            "chan doi", "tuyet vong", "vo dung", "vo gia tri", "la ganh nang", "ganh nang cho",
            "khong ai can", "khong ai quan tam", "khong ai hieu", "khong ai thuong",
            "ghet ban than", "ghet chinh minh", "bat luc", "bi bat nat", "bi danh", "bi de doa",
            "bi co lap", "bi tay chay", "bi xuc pham", "bi quay roi", "bi lam nhuc",
            "mat ngu", "khong ngu duoc", "khong muon di hoc", "muon bien mat",
            "khong the chiu", "khong chiu noi", "muon bo cuoc", "bo nha", "tron nha",
            "khoc suot", "khoc hoai", "khoc moi dem", "so hai", "am anh", "tram cam",
            "hoang loan", "bo me danh", "bi bo roi", "trong rong", "te liet",
            "danh minh", "chan duong", "bi ep", "bi tong tien"
        ],
        accent: []
    },
    1: {
        plain: [
            "cang thang", "ap luc", "stress", "lo lang", "lo au", "lo qua", "lo lam", "lo so", "met moi", "met qua",
            "buon", "chan qua", "chan nan", "nan long", "so thi", "diem kem", "diem thap",
            "bi mang", "cai nhau", "gian", "that tinh", "chia tay", "hoc khong vo",
            "khong hieu bai", "that bai", "co don", "tu ti", "ngai giao tiep", "bi chui"
        ],
        accent: []
    }
};

// Câu nói cường điệu / đùa: KHÔNG tính là nguy cơ khẩn cấp (vd "khó muốn chết", "cười chết mất")
const HYPERBOLE = [
    /\b(kho|met|chan|nong|lanh|doi|dau|nhuc|ngai|so|dep|ngon|vui|thich|hay|cuoi|buon ngu|ham|nho|thuong)( qua| lam)? (muon|gan|suyt|sap) chet\b/g,
    /\b(cuoi|dep|ngon|vui|so|met|nong|lanh|doi|dau) chet (mat|luon|di duoc|toi|minh)\b/g,
    /\bchet (cuoi|me|mat|thoi|roi|chua|luon a)\b/g,
    /\bdep chet\b/g,
    /\bcuoi chet\b/g
];

export function detectKeywords(text) {
    const t0 = Date.now();
    let plain = normalizePlain(text);
    const accent = normalizeAccent(text);
    const matches = [];
    let hyperbole = false;

    for (const re of HYPERBOLE) {
        if (re.test(plain)) {
            hyperbole = true;
            plain = plain.replace(re, " ");
        }
        re.lastIndex = 0;
    }

    let level = 0;
    for (const lv of [3, 2, 1]) {
        for (const k of LEXICON[lv].plain) {
            if (plain.includes(" " + k + " ")) { matches.push({ tu: k, muc: lv }); if (lv > level) level = lv; }
        }
        for (const k of LEXICON[lv].accent) {
            if (accent.includes(" " + k + " ")) { matches.push({ tu: k, muc: lv }); if (lv > level) level = lv; }
        }
    }
    if (hyperbole) {
        // Chỉ ghi chú, KHÔNG nâng mức: câu cường điệu được coi là bình thường ở lớp 1
        matches.push({ tu: "(câu cường điệu – đã bỏ qua)", muc: 0 });
    }
    return { level, matches, hyperbole, ms: Date.now() - t0 };
}

/* =====================================================================
   PHẦN 3. KẾT NỐI AI (Groq)
   ===================================================================== */
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export const REPLY_MODELS = [process.env.GROQ_MODEL, "openai/gpt-oss-120b", "llama-3.3-70b-versatile", "openai/gpt-oss-20b", "llama-3.1-8b-instant"].filter(Boolean);
export const CLASSIFY_MODELS = [process.env.GROQ_CLASSIFY_MODEL, "openai/gpt-oss-20b", "llama-3.3-70b-versatile", "openai/gpt-oss-120b", "llama-3.1-8b-instant"].filter(Boolean);

export function getGroqKey() {
    return (process.env.GROQ_API_KEY || "").trim().replace(/^GROQ_API_KEY\s*=\s*/i, "").replace(/^["']+|["']+$/g, "").trim();
}

async function fetchWithTimeout(url, options, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        return await fetch(url, Object.assign({}, options, { signal: ctrl.signal }));
    } finally {
        clearTimeout(timer);
    }
}

// Gọi AI, thử lần lượt từng model cho đến khi thành công
export async function groqChat({ models, messages, temperature = 0.5, maxTokens = 1024, reasoning = "low", timeoutMs = 25000 }) {
    const apiKey = getGroqKey();
    if (!apiKey) throw new Error("Chưa thiết lập GROQ_API_KEY trên Vercel");
    let lastError = null;
    for (const model of models) {
        try {
            const payload = { model, messages, temperature, max_tokens: maxTokens };
            if (model.startsWith("openai/gpt-oss")) payload.reasoning_effort = reasoning;
            const r = await fetchWithTimeout(GROQ_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
                body: JSON.stringify(payload)
            }, timeoutMs);
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
                const err = new Error((data.error && data.error.message) || `HTTP ${r.status}`);
                err.status = r.status;
                throw err;
            }
            const text = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim();
            if (!text) throw new Error("Model không trả về nội dung");
            return { text, model };
        } catch (err) {
            lastError = err;
            console.error(`Model ${model} lỗi:`, err.status || "", err.message);
            if (err.status === 401) break; // sai key thì dừng
        }
    }
    throw lastError || new Error("Không gọi được AI");
}

/* =====================================================================
   PHẦN 4. LỚP 2 – AI PHÂN LOẠI MỨC NGUY CƠ + CHỦ ĐỀ
   ===================================================================== */
export const TOPICS = {
    hoc_tap: "Học tập",
    thi_cu: "Thi cử",
    ban_be: "Bạn bè",
    gia_dinh: "Gia đình",
    tinh_cam: "Tình cảm",
    ban_than: "Bản thân",
    bat_nat: "Bắt nạt",
    khac: "Khác"
};

const CLASSIFY_PROMPT = `Bạn là bộ phân loại mức độ nguy cơ tâm lý trong tin nhắn của học sinh THPT Việt Nam.
Chỉ trả về DUY NHẤT một dòng JSON, không giải thích thêm:
{"level": <0|1|2|3>, "topic": "<mã chủ đề>", "reason": "<lý do, tối đa 15 từ>"}

Mức nguy cơ:
0 = bình thường: chào hỏi, hỏi bài, trò chuyện, cảm xúc tích cực.
1 = căng thẳng thông thường: buồn, lo lắng, áp lực học tập/thi cử, mâu thuẫn nhỏ.
2 = đáng lo ngại: tuyệt vọng, thấy mình vô dụng/là gánh nặng, cô lập kéo dài, bị bắt nạt hoặc bạo lực, mất ngủ/khóc kéo dài.
3 = khẩn cấp: có ý nghĩ, ý định hoặc kế hoạch tự sát, tự làm hại bản thân, hoặc đang gặp nguy hiểm.

Lưu ý:
- Câu cường điệu, đùa vui ("bài khó muốn chết", "cười chết mất") là mức 0 hoặc 1.
- Xét cả ngữ cảnh các tin nhắn trước của học sinh (nếu có).
- Khi phân vân giữa hai mức, chọn mức CAO hơn (ưu tiên an toàn).

Mã chủ đề (chọn 1): hoc_tap, thi_cu, ban_be, gia_dinh, tinh_cam, ban_than, bat_nat, khac`;

export async function classifyAI(message, previousUserMessages = []) {
    const t0 = Date.now();
    const context = previousUserMessages.slice(-4).map((m, i) => `(${i + 1}) ${m}`).join("\n");
    const userContent = (context ? `Các tin nhắn trước của học sinh:\n${context}\n\n` : "") + `Tin nhắn cần phân loại:\n"""${message}"""`;
    const { text, model } = await groqChat({
        models: CLASSIFY_MODELS,
        messages: [{ role: "system", content: CLASSIFY_PROMPT }, { role: "user", content: userContent }],
        temperature: 0,
        maxTokens: 600,
        reasoning: "low",
        timeoutMs: 15000
    });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("AI phân loại không trả về JSON");
    const obj = JSON.parse(m[0]);
    let level = parseInt(obj.level, 10);
    if (!(level >= 0 && level <= 3)) level = 0;
    const topic = TOPICS[obj.topic] ? obj.topic : "khac";
    return { level, topic, reason: String(obj.reason || "").slice(0, 200), model, ms: Date.now() - t0 };
}

/* =====================================================================
   PHẦN 5. KẾT HỢP 2 LỚP + THEO DÕI CẢ CUỘC TRÒ CHUYỆN
   - Mức tin nhắn = mức CAO HƠN giữa lớp 1 và lớp 2 (ưu tiên an toàn)
   - Điểm tích lũy: điểm mới = điểm cũ × 0,7 + trọng số(mức)
     Trọng số: mức 0→0, 1→1, 2→3, 3→8
   - Nếu điểm tích lũy ≥ 5 thì nâng lên ít nhất mức 2 (học sinh tiêu cực kéo dài)
   ===================================================================== */
export const LEVEL_WEIGHT = [0, 1, 3, 8];
export const DECAY = 0.7;
export const TREND_THRESHOLD = 5;

export function combineRisk(l1Level, l2Level, previousScore = 0) {
    const messageLevel = Math.max(l1Level, (l2Level === null || l2Level === undefined) ? l1Level : l2Level);
    const prev = Math.max(0, Math.min(100, Number(previousScore) || 0));
    const score = Math.round((prev * DECAY + LEVEL_WEIGHT[messageLevel]) * 10) / 10;
    const trend = score >= TREND_THRESHOLD && messageLevel < 2;
    const finalLevel = trend ? 2 : messageLevel;
    return { messageLevel, finalLevel, score, trend };
}

/* =====================================================================
   PHẦN 6. CƠ SỞ DỮ LIỆU UPSTASH REDIS (qua REST, không cần thư viện)
   Tự nhận biến môi trường do Vercel tạo: KV_REST_API_URL/KV_REST_API_TOKEN
   hoặc UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN
   ===================================================================== */
export function redisConfig() {
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

// cmds: mảng các lệnh, vd [["INCR","a"],["GET","b"]] -> trả về mảng kết quả
export async function redis(cmds) {
    const cfg = redisConfig();
    if (!cfg) throw new Error("Chưa kết nối cơ sở dữ liệu (Upstash Redis) trên Vercel");
    const body = cmds.filter(Boolean).map(c => c.map(x => String(x)));
    if (!body.length) return [];
    const r = await fetchWithTimeout(cfg.url + "/pipeline", {
        method: "POST",
        headers: { "Authorization": "Bearer " + cfg.token, "Content-Type": "application/json" },
        body: JSON.stringify(body)
    }, 10000);
    const data = await r.json().catch(() => null);
    if (!r.ok || !Array.isArray(data)) {
        throw new Error("Lỗi cơ sở dữ liệu: " + ((data && data.error) || ("HTTP " + r.status)));
    }
    return data.map(x => (x && x.error) ? null : (x ? x.result : null));
}

export function hashToObject(arr) {
    const o = {};
    if (Array.isArray(arr)) for (let i = 0; i + 1 < arr.length; i += 2) o[arr[i]] = arr[i + 1];
    return o;
}

/* ===== Tuần theo giờ Việt Nam (chuẩn ISO: tuần bắt đầu thứ Hai) ===== */
const DAY = 86400000;
export function weekInfo(ms = Date.now()) {
    const d = new Date(ms + 7 * 3600000); // đổi sang giờ Việt Nam, dùng hàm UTC
    const dow = (d.getUTCDay() + 6) % 7;  // thứ Hai = 0
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
    const thursday = new Date(monday.getTime() + 3 * DAY);
    const year = thursday.getUTCFullYear();
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const week1Monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY);
    const week = 1 + Math.round((monday - week1Monday) / (7 * DAY));
    const dd = x => String(x).padStart(2, "0");
    return {
        key: `${year}-W${dd(week)}`,
        label: `${dd(monday.getUTCDate())}/${dd(monday.getUTCMonth() + 1)}`
    };
}

const TTL = String(400 * 86400); // giữ thống kê ~13 tháng

// Ghi thống kê ẩn danh: chỉ chủ đề, mức nguy cơ, mã cuộc trò chuyện ngẫu nhiên. KHÔNG lưu nội dung tin nhắn.
export async function logEvent({ cid, level, topic, source }) {
    if (!redisConfig()) return;
    const wk = weekInfo().key;
    const safeCid = String(cid || "unknown").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40) || "unknown";
    const cmds = [
        ["HINCRBY", `stats:${wk}:topic`, topic, 1],
        ["HINCRBY", `stats:${wk}:level`, level, 1],
        ["SADD", `stats:${wk}:conv`, safeCid],
        ["EXPIRE", `stats:${wk}:topic`, TTL],
        ["EXPIRE", `stats:${wk}:level`, TTL],
        ["EXPIRE", `stats:${wk}:conv`, TTL]
    ];
    if (level >= 2) {
        cmds.push(["SADD", `stats:${wk}:flag`, safeCid]);
        cmds.push(["EXPIRE", `stats:${wk}:flag`, TTL]);
        cmds.push(["LPUSH", "alerts", JSON.stringify({ t: Date.now(), level, topic, source, cid: safeCid.slice(0, 6) })]);
        cmds.push(["LTRIM", "alerts", 0, 299]);
    }
    await redis(cmds);
}

/* =====================================================================
   PHẦN 7. KIẾN THỨC RIÊNG CỦA TRƯỜNG
   Giáo viên sửa trong Trang giáo viên → "Kiến thức trường" (lưu vào cơ sở dữ liệu).
   Nội dung dưới đây là MẪU BAN ĐẦU khi chưa cập nhật.
   ===================================================================== */
export const DEFAULT_KNOWLEDGE = `TRƯỜNG THPT ĐỨC LINH – THÔNG TIN DÀNH CHO HỌC SINH

1. LỊCH THI / KIỂM TRA
- Kiểm tra giữa học kỳ I: [chưa cập nhật]
- Kiểm tra cuối học kỳ I: [chưa cập nhật]
- Kiểm tra giữa học kỳ II: [chưa cập nhật]
- Kiểm tra cuối học kỳ II: [chưa cập nhật]

2. NỘI QUY CƠ BẢN
- [chưa cập nhật]

3. PHÒNG TƯ VẤN TÂM LÝ HỌC ĐƯỜNG
- Địa điểm, giờ làm việc: [chưa cập nhật]
- Học sinh có thể đặt lịch gặp thầy cô tư vấn ẨN DANH ngay trên trang web bằng nút "Đặt lịch gặp thầy cô tư vấn". Hệ thống cấp một mã hẹn để tra cứu phản hồi.

4. MẸO HỌC TẬP
- Pomodoro: học tập trung 25 phút, nghỉ 5 phút; sau 4 lượt nghỉ dài 15–30 phút.
- Ôn tập ngắt quãng: ôn lại bài sau 1 ngày, 3 ngày, 1 tuần thay vì học dồn một lần.
- Tự kiểm tra: làm đề, tự giải thích lại bài bằng lời của mình thay vì chỉ đọc lại.
- Ngủ đủ giấc (khuyến nghị 8–10 tiếng mỗi đêm cho tuổi 13–18), hạn chế dùng điện thoại trước khi ngủ.
- Trước kỳ thi: lập kế hoạch ôn theo tuần, ưu tiên phần còn yếu, giữ sức khỏe.

5. KHI CẦN HỖ TRỢ KHẨN CẤP
- Tổng đài Quốc gia Bảo vệ Trẻ em: 111 (miễn phí, 24/7)
- Cấp cứu: 115
- Báo ngay cho giáo viên chủ nhiệm, thầy cô tư vấn hoặc cha mẹ.`;

export async function getKnowledge() {
    if (!redisConfig()) return { text: DEFAULT_KNOWLEDGE, isDefault: true };
    try {
        const [v] = await redis([["GET", "kb:school"]]);
        if (v && String(v).trim()) return { text: String(v), isDefault: false };
    } catch (e) {
        console.error("Không đọc được kiến thức trường:", e.message);
    }
    return { text: DEFAULT_KNOWLEDGE, isDefault: true };
}

/* =====================================================================
   PHẦN 8. TIỆN ÍCH CHO API
   ===================================================================== */
export function setCors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Teacher-Password");
}

export function readBody(req) {
    let body = req.body;
    if (typeof body === "string") {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    return body || {};
}

export function cleanText(v, max) {
    return String(v === undefined || v === null ? "" : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max);
}
