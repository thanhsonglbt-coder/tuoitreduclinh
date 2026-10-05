// tệp: /api/chat.js — API trò chuyện + phát hiện nguy cơ nhiều tầng
// API key lưu ở Vercel: Settings → Environment Variables → GROQ_API_KEY
// Bản 10/2026: thêm (1) thẻ giải thích cho chế độ trình diễn, (2) tình huống mẫu, (3) hỏi làm rõ khi câu mơ hồ.

import {
    detectKeywords, getCustomLexicon, getMlModel, mlPredict, classifyAI, combineRisk, groqChat, REPLY_MODELS,
    logEvent, getKnowledge, getGroqKey, redisConfig, redis, setCors, readBody, cleanText,
    telegramConfig, sendTelegram, safeCidOf, vnTime, TOPICS
} from "./_lib.js";
import { SCENARIOS, findSample, detectVague, assessAmbiguity, buildExplain, CLARIFY_PROMPT } from "./_screen.js";

const SOURCE_TEXT = { tu_khoa: "từ điển", AI: "AI", ca_hai: "từ điển và AI", mo_hinh: "mô hình của nhóm", tich_luy: "điểm tích lũy cả cuộc trò chuyện" };

// Báo giáo viên tư vấn qua Telegram khi có mức 3 (mỗi cuộc trò chuyện tối đa 1 lần / 30 phút).
// Chỉ gửi giờ, chủ đề, mã cuộc — KHÔNG có nội dung tin nhắn, KHÔNG có danh tính.
// Trả về: "off" (chưa cấu hình) | "recent" (vừa báo trong 30 phút) | "sent" | "error"
async function alertTeachers({ cid, topic, source, host }) {
    if (!telegramConfig() || !redisConfig()) return "off";
    const c = safeCidOf(cid);
    const [ok] = await redis([["SET", `tg3:${c}`, "1", "NX", "EX", "1800"]]);
    if (ok !== "OK") return "recent";
    const text = `🔴 BẠN ĐỒNG HÀNH – CẢNH BÁO MỨC 3 (khẩn cấp)
Thời gian: ${vnTime()}
Chủ đề: ${TOPICS[topic] || "Khác"}
Phát hiện bởi: ${SOURCE_TEXT[source] || source}
Mã cuộc: ${c.slice(0, 6)}

Học sinh đã được hiện ngay số 111/115 và nút "Muốn thầy cô liên hệ". Hệ thống không biết học sinh là ai và không lưu nội dung tin nhắn. Nếu em tự nguyện để lại liên lạc, thầy cô sẽ nhận thêm một thông báo.
${host ? "Trang giáo viên: https://" + host + "/giaovien.html" : ""}`;
    const r = await sendTelegram(text);
    return r && r.sent ? "sent" : "error";
}

function buildSystemPrompt(knowledge, hintLevel, clarify) {
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
    if (clarify) {
        p += `\n\n${CLARIFY_PROMPT}`;
    } else if (hintLevel >= 2) {
        p += `\n\nLƯU Ý: Bộ lọc an toàn nhận thấy tin nhắn mới nhất có dấu hiệu ${hintLevel >= 3 ? "NGUY CƠ KHẨN CẤP" : "đáng lo ngại"}. Hãy phản hồi theo đúng hướng dẫn an toàn ở trên.`;
        if (hintLevel >= 3) p += ` Hãy nhẹ nhàng hỏi xem bạn ấy có đang an toàn ngay lúc này không, và nhắc rằng bạn ấy có thể bấm nút "Muốn thầy cô liên hệ" trên màn hình nếu muốn thầy cô tư vấn gọi cho mình.`;
    }
    return p;
}

export default async function handler(req, res) {
    setCors(res);
    if (req.method === "OPTIONS") return res.status(200).end();

    // ===== Danh sách tình huống mẫu cho chế độ trình diễn: /api/chat?scenarios=1 =====
    if (req.method === "GET" && ((req.query && req.query.scenarios) || /[?&]scenarios=1/.test(req.url || ""))) {
        return res.status(200).json({
            scenarios: SCENARIOS.map(s => ({ id: s.id, group: s.group, title: s.title, text: s.text, expect: s.expect }))
        });
    }

    // ===== TRANG TỰ KIỂM TRA: mở /api/chat trên trình duyệt =====
    if (req.method === "GET") {
        const key = getGroqKey();
        const report = {
            co_api_key: !!key,
            ky_tu_dau: key ? key.slice(0, 4) + "..." : "(trống)",
            co_so_du_lieu: redisConfig() ? "đã cấu hình" : "CHƯA kết nối (thống kê, đặt lịch sẽ không hoạt động)",
            mat_khau_giao_vien: process.env.TEACHER_PASSWORD ? "đã đặt" : "CHƯA đặt TEACHER_PASSWORD",
            bao_dong_telegram: telegramConfig() ? "đã cấu hình" : "chưa cấu hình (không bắt buộc)"
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
        if (!message) return res.status(400).json({ error: "Tin nhắn trống" });

        // Tình huống mẫu: khớp đúng mã + nguyên văn → chạy độc lập, không ghi thống kê, không báo Telegram
        const sample = findSample(message, cleanText(body.sample, 20));
        const screenOnly = !!sample && body.screenOnly === true;      // chỉ sàng lọc, không sinh câu trả lời (dùng cho "Chạy thử tất cả")
        const wantExplain = body.demo === true || !!sample;           // giao diện bật chế độ giải thích
        const cooldown = body.clarifyCooldown === true;
        const prevScore = sample ? 0 : (Number(body.riskScore) || 0);

        const cleanHistory = history
            .filter(m => m && m.parts && m.parts[0] && typeof m.parts[0].text === "string")
            .map(m => ({ role: m.role === "user" ? "user" : "assistant", content: cleanText(m.parts[0].text, 4000) }));
        const previousUserMessages = cleanHistory.filter(m => m.role === "user").map(m => m.content);

        // TẦNG 1: bộ lọc tiếng Việt (chạy ngay, không cần AI)
        const l1 = detectKeywords(message, 2, await getCustomLexicon());

        // TẦNG 2: mô hình học máy của học sinh (nếu giáo viên đã bật)
        let ml = null, mlActive = false;
        try {
            const mlState = await getMlModel();
            if (mlState.active && mlState.model) {
                mlActive = true;
                const t0 = Date.now();
                const r = mlPredict(mlState.model, message);
                if (r) ml = { level: r.level, prob: r.prob, ms: Date.now() - t0 };
            }
        } catch (e) { console.error("Lỗi mô hình học máy:", e.message); }
        const mlLevel = ml ? ml.level : 0;
        const early = Math.max(l1.level, mlLevel);
        const vague = detectVague(message);

        // TẦNG 3: AI phân loại
        const l2Promise = classifyAI(message, previousUserMessages)
            .catch(e => { console.error("Lớp 2 lỗi:", e && e.message); return null; });

        const knowledge = screenOnly ? "" : (await getKnowledge()).text;
        const startReply = (hint, clarifyOn) => {
            const messages = [{ role: "system", content: buildSystemPrompt(knowledge, hint, clarifyOn) }]
                .concat(cleanHistory, [{ role: "user", content: message }]);
            const p = groqChat({ models: REPLY_MODELS, messages, temperature: 0.5, maxTokens: 2048, reasoning: "medium" });
            p.catch(() => { });
            return p;
        };

        let l2 = null, replyPromise = null, clarify = { on: false, reason: "" };
        if (screenOnly) {
            l2 = await l2Promise;
        } else if (early >= 3) {
            // Khẩn cấp rõ ràng: trả lời ngay, chạy song song với AI phân loại cho nhanh
            replyPromise = startReply(early, false);
            l2 = await l2Promise;
        } else {
            // Chờ AI phân loại xong (thường < 1 giây) để biết có cần hỏi làm rõ không
            l2 = await l2Promise;
            clarify = assessAmbiguity({ l1Level: l1.level, l2Level: l2 ? l2.level : null, mlLevel, vague, cooldown });
            replyPromise = startReply(Math.max(early, l2 ? l2.level : 0), clarify.on);
        }

        // KẾT HỢP các tầng + điểm tích lũy cả cuộc trò chuyện (ưu tiên an toàn: lấy mức cao nhất)
        const risk = combineRisk(early, l2 ? l2.level : null, prevScore);
        const topic = l2 ? l2.topic : "khac";
        const l2v = l2 ? l2.level : -1, best = Math.max(l1.level, mlLevel, l2v);
        const source = (l2v === best && l1.level === best) ? "ca_hai" : l2v === best ? "AI" : l1.level === best ? "tu_khoa" : "mo_hinh";
        const finalSource = risk.trend ? "tich_luy" : source;

        let telegram = sample ? "sample" : "no";
        if (!sample) {
            // Ghi thống kê ẩn danh (không lưu nội dung). Lỗi ghi thì bỏ qua, không ảnh hưởng học sinh.
            try {
                await logEvent({ cid, level: risk.finalLevel, topic, source: finalSource });
            } catch (e) {
                console.error("Không ghi được thống kê:", e.message);
            }
            if (risk.finalLevel >= 3) {
                try { telegram = await alertTeachers({ cid, topic, source: finalSource, host: req.headers && req.headers.host }); }
                catch (e) { console.error("Không gửi được Telegram:", e.message); telegram = "error"; }
            }
        }

        let text = "";
        if (!screenOnly) {
            const replyResult = await replyPromise;   // lỗi AI trả lời → rơi vào catch bên dưới như trước
            text = replyResult.text;
        }

        const out = {
            text,
            risk: { level: risk.finalLevel, score: risk.score, trend: risk.trend, topic, clarify: clarify.on }
        };
        if (wantExplain) {
            out.explain = buildExplain({ message, l1, ml, mlActive, l2, risk, prevScore, clarify, topic, sample, telegram });
        }
        return res.status(200).json(out);
    } catch (error) {
        console.error("Lỗi xử lý máy chủ:", error);
        return res.status(500).json({ error: error.message || "Lỗi xử lý AI nội bộ" });
    }
}
