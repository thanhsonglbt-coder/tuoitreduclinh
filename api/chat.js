// tệp: /api/chat.js — API trò chuyện + phát hiện nguy cơ 2 lớp
// API key lưu ở Vercel: Settings → Environment Variables → GROQ_API_KEY

import {
    detectKeywords, getCustomLexicon, classifyAI, combineRisk, groqChat, REPLY_MODELS,
    logEvent, getKnowledge, getGroqKey, redisConfig, redis, setCors, readBody, cleanText
} from "./_lib.js";

function buildSystemPrompt(knowledge, l1Level) {
    let p = `Bạn là "Bạn Đồng Hành" – trợ lý AI của Trường THPT Đức Linh dành cho học sinh. Luôn trả lời bằng tiếng Việt, xưng "mình", gọi người dùng là "bạn".

VAI TRÒ CHÍNH – LẮNG NGHE, HỖ TRỢ TÂM LÝ HỌC ĐƯỜNG:
- Khi học sinh chia sẻ áp lực học tập, thi cử, bạn bè, gia đình, tình cảm: trả lời ấm áp, đồng cảm, nhẹ nhàng, tuyệt đối không phán xét; ngắn gọn (3–5 câu), xoa dịu cảm xúc, đặt câu hỏi gợi mở để học sinh chia sẻ thêm.
- Khi học sinh có dấu hiệu đáng lo (tuyệt vọng, bị bắt nạt, cô lập kéo dài…): nhẹ nhàng gợi ý học sinh gặp thầy cô tư vấn của trường (có thể đặt lịch ẩn danh bằng nút "Đặt lịch gặp thầy cô tư vấn" trên trang).
- Khi học sinh có ý định tự làm hại bản thân hoặc đang gặp nguy hiểm: thể hiện sự quan tâm chân thành, khuyên gọi NGAY Tổng đài 111 (miễn phí 24/7) hoặc 115, và báo ngay cho thầy cô, cha mẹ hoặc người lớn tin tưởng. Không hướng dẫn bất kỳ cách thức gây hại nào.
- Bạn không phải bác sĩ, không chẩn đoán bệnh.

VAI TRÒ PHỤ – HỖ TRỢ HỌC TẬP:
- Khi học sinh hỏi bài (Toán và các môn khác): giải thích từng bước rõ ràng, nêu kết luận; ưu tiên gợi ý để học sinh tự hiểu.
- Viết công thức Toán: trong dòng dùng $...$, riêng một dòng dùng $$...$$, nhiều dòng dùng $$\\begin{aligned} ... \\end{aligned}$$. Không dùng bảng Markdown, không dùng khối code.

THÔNG TIN RIÊNG CỦA TRƯỜNG:
- Khi học sinh hỏi về lịch thi, nội quy, phòng tư vấn… của trường: CHỈ dùng thông tin trong phần dưới đây. Mục nào ghi "[chưa cập nhật]" hoặc không có thì nói là mình chưa có thông tin và gợi ý hỏi giáo viên chủ nhiệm. Không tự bịa.
<<<THÔNG TIN TRƯỜNG
${knowledge}
THÔNG TIN TRƯỜNG>>>`;
    if (l1Level >= 2) {
        p += `\n\nLƯU Ý: Bộ lọc an toàn nhận thấy tin nhắn mới nhất có dấu hiệu ${l1Level >= 3 ? "NGUY CƠ KHẨN CẤP" : "đáng lo ngại"}. Hãy phản hồi theo đúng hướng dẫn an toàn ở trên.`;
    }
    return p;
}

export default async function handler(req, res) {
    setCors(res);
    if (req.method === "OPTIONS") return res.status(200).end();

    // ===== TRANG TỰ KIỂM TRA: mở /api/chat trên trình duyệt =====
    if (req.method === "GET") {
        const key = getGroqKey();
        const report = {
            co_api_key: !!key,
            ky_tu_dau: key ? key.slice(0, 4) + "..." : "(trống)",
            co_so_du_lieu: redisConfig() ? "đã cấu hình" : "CHƯA kết nối (thống kê, đặt lịch sẽ không hoạt động)",
            mat_khau_giao_vien: process.env.TEACHER_PASSWORD ? "đã đặt" : "CHƯA đặt TEACHER_PASSWORD"
        };
        if (redisConfig()) {
            try { await redis([["PING"]]); report.co_so_du_lieu = "OK - kết nối tốt"; }
            catch (e) { report.co_so_du_lieu = "LỖI: " + e.message; }
        }
        if (key) {
            try {
                const r = await groqChat({ models: REPLY_MODELS, messages: [{ role: "user", content: "Chào bạn, trả lời 1 câu ngắn." }], maxTokens: 300 });
                report.ket_noi_AI = "OK - hoạt động tốt (" + r.model + ")";
            } catch (e) {
                report.ket_noi_AI = "LỖI: " + e.message;
            }
        }
        return res.status(200).json(report);
    }

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Chương trình chỉ hỗ trợ phương thức POST" });
    }
    if (!getGroqKey()) {
        return res.status(500).json({ error: "Chưa thiết lập GROQ_API_KEY trên Vercel (Settings → Environment Variables)" });
    }

    try {
        const body = readBody(req);
        const message = cleanText(body.message, 2000);
        const history = Array.isArray(body.history) ? body.history.slice(-20) : [];
        const cid = cleanText(body.cid, 40);
        const prevScore = Number(body.riskScore) || 0;
        if (!message) return res.status(400).json({ error: "Tin nhắn trống" });

        const cleanHistory = history
            .filter(m => m && m.parts && m.parts[0] && typeof m.parts[0].text === "string")
            .map(m => ({ role: m.role === "user" ? "user" : "assistant", content: cleanText(m.parts[0].text, 4000) }));
        const previousUserMessages = cleanHistory.filter(m => m.role === "user").map(m => m.content);

        // LỚP 1: từ khóa (chạy ngay, không cần AI)
        const l1 = detectKeywords(message, 2, await getCustomLexicon());

        // LỚP 2 (AI phân loại) và câu trả lời chạy SONG SONG cho nhanh
        const knowledge = (await getKnowledge()).text;
        const messages = [{ role: "system", content: buildSystemPrompt(knowledge, l1.level) }]
            .concat(cleanHistory, [{ role: "user", content: message }]);

        const [l2Result, replyResult] = await Promise.allSettled([
            classifyAI(message, previousUserMessages),
            groqChat({ models: REPLY_MODELS, messages, temperature: 0.5, maxTokens: 2048, reasoning: "medium" })
        ]);

        if (replyResult.status !== "fulfilled") {
            throw replyResult.reason;
        }
        const l2 = l2Result.status === "fulfilled" ? l2Result.value : null;
        if (!l2) console.error("Lớp 2 lỗi:", l2Result.reason && l2Result.reason.message);

        // KẾT HỢP 2 lớp + điểm tích lũy cả cuộc trò chuyện
        const risk = combineRisk(l1.level, l2 ? l2.level : null, prevScore);
        const topic = l2 ? l2.topic : "khac";
        const source = l2 && l2.level >= l1.level ? (l1.level === l2.level ? "ca_hai" : "AI") : "tu_khoa";

        // Ghi thống kê ẩn danh (không lưu nội dung). Lỗi ghi thì bỏ qua, không ảnh hưởng học sinh.
        try {
            await logEvent({ cid, level: risk.finalLevel, topic, source: risk.trend ? "tich_luy" : source });
        } catch (e) {
            console.error("Không ghi được thống kê:", e.message);
        }

        return res.status(200).json({
            text: replyResult.value.text,
            risk: { level: risk.finalLevel, score: risk.score, trend: risk.trend, topic }
        });
    } catch (error) {
        console.error("Lỗi xử lý máy chủ:", error);
        return res.status(500).json({ error: error.message || "Lỗi xử lý AI nội bộ" });
    }
}
