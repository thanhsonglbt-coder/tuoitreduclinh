// tệp: /api/chat.js  — Serverless Function trên Vercel
// Dùng AI của Groq (miễn phí). API key lưu ở Vercel: Settings → Environment Variables → GROQ_API_KEY

const SYSTEM_PROMPT = "Bạn là chuyên gia tư vấn tâm lý học đường mang tên 'Bạn Đồng Hành'. Luôn trả lời bằng tiếng Việt. Hãy luôn lắng nghe học sinh với thái độ ấm áp, đồng cảm, nhẹ nhàng và tuyệt đối không phán xét. Nhiệm vụ của bạn là lắng nghe áp lực học tập, thi cử hoặc mâu thuẫn bạn bè của học sinh cấp 2, cấp 3. Hãy đưa ra câu trả lời ngắn gọn (tối đa 3-4 câu), tập trung xoa dịu cảm xúc và đặt câu hỏi gợi mở để học sinh tâm sự tiếp. Nếu phát hiện học sinh có dấu hiệu muốn tự hại nghiêm trọng, hãy khuyên học sinh gọi ngay Tổng đài 111 (miễn phí 24/7) hoặc 115, và tìm đến thầy cô, cha mẹ hoặc người lớn tin tưởng ngay lập tức.";

// Thử lần lượt các model, model nào chạy được thì dùng
const MODELS = [
    process.env.GROQ_MODEL,
    "openai/gpt-oss-120b",
    "llama-3.3-70b-versatile",
    "openai/gpt-oss-20b",
    "llama-3.1-8b-instant"
].filter(Boolean);

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

function getApiKey() {
    return (process.env.GROQ_API_KEY || "")
        .trim()
        .replace(/^GROQ_API_KEY\s*=\s*/i, "")
        .replace(/^["']+|["']+$/g, "")
        .trim();
}

async function callGroq(model, apiKey, messages) {
    const payload = {
        model,
        messages,
        temperature: 0.7,
        max_tokens: 1024
    };
    // Model gpt-oss có chế độ "suy nghĩ": đặt mức thấp để trả lời nhanh
    if (model.startsWith("openai/gpt-oss")) {
        payload.reasoning_effort = "low";
    }

    const r = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + apiKey
        },
        body: JSON.stringify(payload)
    });
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
        const err = new Error((data.error && data.error.message) || `HTTP ${r.status}`);
        err.status = r.status;
        throw err;
    }

    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "").trim();
    if (!text) {
        const err = new Error("Model không trả về nội dung");
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
            ky_tu_dau: apiKey ? apiKey.slice(0, 4) + "..." : "(trống)"
        };
        if (apiKey) {
            try {
                const text = await callGroq(MODELS[0], apiKey, [{ role: "user", content: "Chào bạn, trả lời 1 câu ngắn." }]);
                report.ket_noi_AI = "OK - hoạt động tốt";
                report.cau_tra_loi_thu = text;
            } catch (e) {
                report.ket_noi_AI = "LỖI: " + e.message;
            }
        }
        return res.status(200).json(report);
    }

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Chương trình chỉ hỗ trợ phương thức POST" });
    }

    if (!apiKey) {
        return res.status(500).json({ error: "Chưa thiết lập GROQ_API_KEY trên Vercel (Settings → Environment Variables)" });
    }

    try {
        let body = req.body;
        if (typeof body === "string") {
            try { body = JSON.parse(body); } catch (e) { body = {}; }
        }
        const message = ((body && body.message) || "").toString().trim();
        const history = Array.isArray(body && body.history) ? body.history : [];

        if (!message) return res.status(400).json({ error: "Tin nhắn trống" });

        // Chuyển lịch sử từ giao diện sang định dạng của Groq
        const messages = [{ role: "system", content: SYSTEM_PROMPT }];
        history
            .filter(m => m && m.parts && m.parts[0] && typeof m.parts[0].text === "string")
            .forEach(m => messages.push({
                role: m.role === "user" ? "user" : "assistant",
                content: m.parts[0].text
            }));
        messages.push({ role: "user", content: message });

        let lastError = null;
        for (const model of MODELS) {
            try {
                const text = await callGroq(model, apiKey, messages);
                return res.status(200).json({ text, model });
            } catch (err) {
                lastError = err;
                console.error(`Model ${model} lỗi:`, err.status, err.message);
                if (err.status === 401) break; // sai key thì dừng luôn
            }
        }

        return res.status(500).json({ error: (lastError && lastError.message) || "Lỗi xử lý AI nội bộ" });
    } catch (error) {
        console.error("Lỗi xử lý máy chủ:", error);
        return res.status(500).json({ error: error.message || "Lỗi xử lý AI nội bộ" });
    }
}