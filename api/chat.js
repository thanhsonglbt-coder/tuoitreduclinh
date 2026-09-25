// tệp: /api/chat.js  — Serverless Function trên Vercel
// Gọi trực tiếp REST API của Gemini, không cần thư viện ngoài.
// API key KHÔNG để trong code. Key được lưu ở Vercel: Settings → Environment Variables → GEMINI_API_KEY

const SYSTEM_PROMPT = "Bạn là chuyên gia tư vấn tâm lý học đường mang tên 'Bạn Đồng Hành'. Hãy luôn lắng nghe học sinh với thái độ ấm áp, đồng cảm, nhẹ nhàng và tuyệt đối không phán xét. Nhiệm vụ của bạn là lắng nghe áp lực học tập, thi cử hoặc mâu thuẫn bạn bè của học sinh cấp 2, cấp 3. Hãy đưa ra câu trả lời ngắn gọn (tối đa 3-4 câu), tập trung xoa dịu cảm xúc và đặt câu hỏi gợi mở để học sinh tâm sự tiếp. Nếu phát hiện học sinh có dấu hiệu muốn tự hại nghiêm trọng, hãy khuyên học sinh gọi ngay Tổng đài 111 (miễn phí 24/7) hoặc 115, và tìm đến thầy cô, cha mẹ hoặc người lớn tin tưởng ngay lập tức.";

const MODELS = [
    process.env.GEMINI_MODEL,
    "gemini-3.5-flash",
    "gemini-flash-latest",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite"
].filter(Boolean);

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// Lấy key từ Vercel và làm sạch (bỏ khoảng trắng, xuống dòng, dấu ngoặc kép)
function getApiKey() {
    return (process.env.GEMINI_API_KEY || "")
        .trim()
        .replace(/^GEMINI_API_KEY\s*=\s*/i, "")
        .replace(/^["']+|["']+$/g, "")
        .trim();
}

// Gửi request tới Google, thử 2 cách truyền key: qua header, rồi qua URL
async function googleFetch(path, apiKey, options) {
    options = options || {};
    const attempts = [
        { url: `${BASE_URL}${path}`, headers: { "x-goog-api-key": apiKey } },
        { url: `${BASE_URL}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(apiKey)}`, headers: {} }
    ];
    let last = null;
    for (const a of attempts) {
        const r = await fetch(a.url, {
            method: options.method || "GET",
            headers: Object.assign({ "Content-Type": "application/json" }, a.headers),
            body: options.body
        });
        const data = await r.json().catch(() => ({}));
        last = { ok: r.ok, status: r.status, data };
        if (r.ok) return last;
        if (r.status !== 401 && r.status !== 403) return last;
    }
    return last;
}

async function callGemini(model, apiKey, contents) {
    const r = await googleFetch(`/models/${model}:generateContent`, apiKey, {
        method: "POST",
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents,
            generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
        })
    });

    if (!r.ok) {
        const err = new Error((r.data.error && r.data.error.message) || `HTTP ${r.status}`);
        err.status = r.status;
        throw err;
    }

    const data = r.data;
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const text = parts.filter(p => !p.thought).map(p => p.text || "").join("").trim();

    if (!text) {
        const reason = (data.candidates && data.candidates[0] && data.candidates[0].finishReason) ||
                       (data.promptFeedback && data.promptFeedback.blockReason) || "không rõ";
        const err = new Error("Model không trả về nội dung (lý do: " + reason + ")");
        err.status = 502;
        throw err;
    }
    return text;
}

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(200).end();

    const apiKey = getApiKey();

    // ===== TRANG TỰ KIỂM TRA: mở /api/chat trên trình duyệt =====
    if (req.method === "GET") {
        const report = {
            co_api_key: !!apiKey,
            do_dai_key: apiKey.length,
            ky_tu_dau: apiKey ? apiKey.slice(0, 4) + "..." : "(trống)"
        };
        if (apiKey) {
            try {
                const r = await googleFetch("/models?pageSize=100", apiKey);
                report.google_chap_nhan_key = r.ok;
                report.google_tra_loi = r.ok ? "OK - key hợp lệ" : ((r.data.error && r.data.error.message) || ("HTTP " + r.status));
                if (r.ok && Array.isArray(r.data.models)) {
                    report.cac_model_flash_dung_duoc = r.data.models
                        .map(m => m.name.replace("models/", ""))
                        .filter(n => n.includes("flash"))
                        .slice(0, 15);
                }
            } catch (e) {
                report.google_tra_loi = "Không kết nối được Google: " + e.message;
            }
        }
        return res.status(200).json(report);
    }

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Chương trình chỉ hỗ trợ phương thức POST" });
    }

    if (!apiKey) {
        return res.status(500).json({ error: "Chưa thiết lập GEMINI_API_KEY trên Vercel (Settings → Environment Variables)" });
    }

    try {
        let body = req.body;
        if (typeof body === "string") {
            try { body = JSON.parse(body); } catch (e) { body = {}; }
        }
        const message = ((body && body.message) || "").toString().trim();
        const history = Array.isArray(body && body.history) ? body.history : [];

        if (!message) return res.status(400).json({ error: "Tin nhắn trống" });

        const contents = history
            .filter(m => m && m.parts && m.parts[0] && typeof m.parts[0].text === "string")
            .map(m => ({
                role: m.role === "user" ? "user" : "model",
                parts: [{ text: m.parts[0].text }]
            }));
        contents.push({ role: "user", parts: [{ text: message }] });

        let lastError = null;
        for (const model of MODELS) {
            try {
                const text = await callGemini(model, apiKey, contents);
                return res.status(200).json({ text, model });
            } catch (err) {
                lastError = err;
                console.error(`Model ${model} lỗi:`, err.status, err.message);
                if (err.status === 401 || err.status === 403 || /API key/i.test(err.message)) break;
            }
        }

        return res.status(500).json({ error: (lastError && lastError.message) || "Lỗi xử lý AI nội bộ" });
    } catch (error) {
        console.error("Lỗi xử lý máy chủ:", error);
        return res.status(500).json({ error: error.message || "Lỗi xử lý AI nội bộ" });
    }
}