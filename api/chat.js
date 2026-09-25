// tệp: /api/chat.js  — Serverless Function trên Vercel
// Gọi trực tiếp REST API của Gemini, không cần thư viện ngoài.

const SYSTEM_PROMPT = "Bạn là chuyên gia tư vấn tâm lý học đường mang tên 'Bạn Đồng Hành'. Hãy luôn lắng nghe học sinh với thái độ ấm áp, đồng cảm, nhẹ nhàng và tuyệt đối không phán xét. Nhiệm vụ của bạn là lắng nghe áp lực học tập, thi cử hoặc mâu thuẫn bạn bè của học sinh cấp 2, cấp 3. Hãy đưa ra câu trả lời ngắn gọn (tối đa 3-4 câu), tập trung xoa dịu cảm xúc và đặt câu hỏi gợi mở để học sinh tâm sự tiếp. Nếu phát hiện học sinh có dấu hiệu muốn tự hại nghiêm trọng, hãy khuyên học sinh gọi ngay Tổng đài 111 (miễn phí 24/7) hoặc 115, và tìm đến thầy cô, cha mẹ hoặc người lớn tin tưởng ngay lập tức.";

// Danh sách model thử lần lượt. Có thể đặt biến môi trường GEMINI_MODEL trên Vercel để ưu tiên model khác.
const MODELS = [
    process.env.GEMINI_MODEL,
    "gemini-3.5-flash",
    "gemini-flash-latest",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite"
].filter(Boolean);

async function callGemini(model, apiKey, contents) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents,
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 1024 // đủ chỗ cho phần "suy nghĩ" của model mới + câu trả lời
            }
        })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        const msg = (data.error && data.error.message) || `HTTP ${response.status}`;
        const err = new Error(msg);
        err.status = response.status;
        throw err;
    }

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
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Chương trình chỉ hỗ trợ phương thức POST" });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: "Hệ thống chưa thiết lập cấu hình GEMINI_API_KEY trên Vercel" });
    }

    try {
        let body = req.body;
        if (typeof body === "string") {
            try { body = JSON.parse(body); } catch (e) { body = {}; }
        }
        const message = ((body && body.message) || "").toString().trim();
        const history = Array.isArray(body && body.history) ? body.history : [];

        if (!message) {
            return res.status(400).json({ error: "Tin nhắn trống" });
        }

        // Chuẩn hóa lịch sử hội thoại
        const contents = history
            .filter(m => m && m.parts && m.parts[0] && typeof m.parts[0].text === "string")
            .map(m => ({
                role: m.role === "user" ? "user" : "model",
                parts: [{ text: m.parts[0].text }]
            }));
        contents.push({ role: "user", parts: [{ text: message }] });

        // Thử lần lượt từng model, model nào chạy được thì dùng
        let lastError = null;
        for (const model of MODELS) {
            try {
                const text = await callGemini(model, apiKey, contents);
                return res.status(200).json({ text, model });
            } catch (err) {
                lastError = err;
                console.error(`Model ${model} lỗi:`, err.status, err.message);
                // Sai API key (400/401) thì dừng luôn, không thử model khác
                if (err.status === 401 || /API key/i.test(err.message)) break;
            }
        }

        return res.status(500).json({ error: (lastError && lastError.message) || "Lỗi xử lý AI nội bộ" });
    } catch (error) {
        console.error("Lỗi xử lý máy chủ:", error);
        return res.status(500).json({ error: error.message || "Lỗi xử lý AI nội bộ" });
    }
}