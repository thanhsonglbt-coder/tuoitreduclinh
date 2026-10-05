// tệp: /api/_screen.js — THƯ VIỆN "NHÌN THẤY BỘ SÀNG LỌC" (thêm tháng 10/2026)
// Gồm: (1) Tình huống mẫu để trình diễn, (2) Phát hiện câu mơ hồ → hỏi làm rõ,
//      (3) Dựng "thẻ giải thích" cho chế độ trình diễn (tô sáng từ khóa, từng tầng chấm mấy mức).
// Tệp bắt đầu bằng "_" nên Vercel không biến thành API.

import { normalizePlain, normalizeAccent, TOPICS, LEVEL_WEIGHT, DECAY, TREND_THRESHOLD } from "./_lib.js";

/* =====================================================================
   PHẦN 1. TÌNH HUỐNG MẪU
   expect: { min, max, clarify } — kỳ vọng để nút "Chạy thử tất cả" tự đối chiếu (✅/⚠️).
   Các tình huống chỉ chạy qua nút trên giao diện; máy chủ nhận ra đúng nguyên văn
   nên KHÔNG ghi thống kê và KHÔNG báo Telegram cho giáo viên.
   ===================================================================== */
export const SCENARIOS = [
    { id: "kho-1", group: "Tiếng Việt khó, hệ thống vẫn nhận ra", title: "Không dấu + teencode",
      text: "mk k muon song nua r", expect: { min: 3 } },
    { id: "kho-2", group: "Tiếng Việt khó, hệ thống vẫn nhận ra", title: "Viết tách từng chữ",
      text: "m u ố n c h ế t", expect: { min: 3 } },
    { id: "kho-3", group: "Tiếng Việt khó, hệ thống vẫn nhận ra", title: "Nói ẩn ý, không có từ nặng",
      text: "Nếu không còn mình thì chắc mọi người nhẹ nhõm hơn", expect: { min: 3 } },

    { id: "ai-1", group: "AI bổ sung cho từ điển", title: "Từ điển bỏ sót, AI nhận ra",
      text: "Cả lớp lơ mình mấy tuần nay, ăn cơm một mình, về nhà chỉ biết khóc", expect: { min: 2, clarify: false } },

    { id: "ok-1", group: "Không báo động nhầm", title: "Nói cường điệu",
      text: "Bài tập này khó muốn chết luôn, cười chết mất thôi", expect: { max: 1 } },
    { id: "ok-2", group: "Không báo động nhầm", title: "Câu phủ định",
      text: "Mình không hề muốn chết, chỉ là hơi mệt vì ôn thi thôi", expect: { max: 1 } },
    { id: "ok-3", group: "Không báo động nhầm", title: "Nói về nhân vật văn học",
      text: "Em đang phân tích nhân vật Mị trong Vợ chồng A Phủ, đoạn Mị nghĩ đến chuyện tự tử, mai em thuyết trình", expect: { max: 1 } },
    { id: "ok-4", group: "Không báo động nhầm", title: "Thành ngữ, nói đùa",
      text: "Đề Toán hôm nay khó xỉu, chắc mình đi đời nhà ma rồi 😭", expect: { max: 1 } },

    { id: "mo-1", group: "Mơ hồ, hệ thống hỏi làm rõ", title: "Mệt, không muốn làm gì",
      text: "Mình mệt lắm, không muốn làm gì nữa", expect: { min: 1, max: 2, clarify: true } },
    { id: "mo-2", group: "Mơ hồ, hệ thống hỏi làm rõ", title: "Thu mình, né mọi người",
      text: "Dạo này mình chẳng muốn nói chuyện với ai nữa", expect: { min: 1, max: 2, clarify: true } },
    { id: "mo-3", group: "Mơ hồ, hệ thống hỏi làm rõ", title: "Từ điển báo động, AI thấy nhẹ hơn",
      text: "Mình bị đánh giá thấp trong nhóm làm bài tập nên hơi buồn", expect: { max: 2, clarify: true } }
];

// Máy chủ chỉ coi là "tình huống mẫu" khi mã và nguyên văn khớp hoàn toàn
export function findSample(message, id) {
    if (!id) return null;
    const s = SCENARIOS.find(x => x.id === id);
    return s && s.text === message ? s : null;
}

/* =====================================================================
   PHẦN 2. CÂU MƠ HỒ → HỎI LÀM RÕ
   Chỉ hỏi khi chưa tới mức khẩn cấp (mức 3 luôn đi thẳng đường an toàn) và:
   (A) từ điển báo mức 2 nhưng AI chấm ≤ 1 (có thể là báo nhầm), hoặc
   (C) câu có cụm chung chung kiểu "không muốn làm gì nữa" và hai tầng chưa cùng báo đáng lo.
   Không hỏi liên tiếp: sau một lần hỏi, 2 lượt sau không hỏi lại.
   Hệ thống KHÔNG hạ mức: mức vẫn tính theo nguyên tắc ưu tiên an toàn; chỉ hoãn thẻ gợi ý một lượt để hỏi trước.
   ===================================================================== */
const VAGUE = [
    "khong muon lam gi", "chang muon lam gi", "khong muon noi chuyen voi ai", "chang muon noi chuyen voi ai",
    "khong muon gap ai", "khong muon gap ban", "mat dong luc", "mat het dong luc", "khong con dong luc",
    "kiet suc", "met lam roi", "khong biet phai lam sao", "khong biet lam sao nua"
];

export function detectVague(text) {
    const p = normalizePlain(text);
    return VAGUE.filter(k => p.includes(" " + k + " "));
}

export function assessAmbiguity({ l1Level, l2Level, mlLevel, vague, cooldown }) {
    const hasL2 = typeof l2Level === "number";
    const max = Math.max(l1Level, mlLevel || 0, hasL2 ? l2Level : 0);
    let reason = "";
    if (max < 3) {
        if (l1Level === 2 && hasL2 && l2Level <= 1) {
            reason = "Từ điển báo mức 2 nhưng AI chấm nhẹ hơn: có thể là báo nhầm, nên hỏi lại trước khi gợi ý gặp thầy cô.";
        } else if (vague && vague.length && !(l1Level >= 2 && hasL2 && l2Level >= 2)) {
            reason = "Câu nói còn chung chung (\"" + vague[0] + "\"), chưa rõ nguyên nhân và mức độ.";
        }
    }
    if (!reason) return { on: false, reason: "" };
    if (cooldown) return { on: false, reason: "Đáng ra nên hỏi làm rõ, nhưng vừa hỏi ở lượt trước nên không hỏi liên tục." };
    return { on: true, reason };
}

export const CLARIFY_PROMPT = `LƯU Ý (CHƯA CHẮC CHẮN): tin nhắn mới nhất còn mơ hồ, hệ thống chưa biết bạn ấy đang ở mức nào. Lượt này hãy: (1) đồng cảm thật ngắn (1–2 câu) với cảm xúc bạn ấy vừa nói; (2) đặt DUY NHẤT một câu hỏi mở, nhẹ nhàng để hiểu rõ hơn (ví dụ: chuyện này bắt đầu từ khi nào, hoặc điều gì khiến bạn thấy như vậy); (3) KHÔNG chẩn đoán, KHÔNG hỏi dồn nhiều câu, chưa cần nhắc số khẩn cấp hay đặt lịch ở lượt này. Nếu bạn ấy nhắc đến ý nghĩ làm hại bản thân thì làm theo hướng dẫn an toàn.`;

/* =====================================================================
   PHẦN 3. THẺ GIẢI THÍCH (chỉ trả về khi giao diện bật chế độ giải thích)
   ===================================================================== */

// Tô sáng các từ trong tin nhắn gốc mà bộ lọc đã khớp (khớp theo từng từ sau khi chuẩn hóa)
function highlightTokens(message, hits) {
    const toks = String(message || "").slice(0, 2000).split(/\s+/).filter(Boolean);
    const plainW = toks.map(t => normalizePlain(t).trim().split(" ").filter(Boolean));
    const accW = toks.map(t => normalizeAccent(t).trim().split(" ").filter(Boolean));
    const flat = arrs => { const f = []; arrs.forEach((ws, i) => ws.forEach(w => f.push({ w, i }))); return f; };
    const fp = flat(plainW), fa = flat(accW);
    const marks = new Array(toks.length).fill(0);

    const markPhrase = (f, words, muc) => {
        const n = words.length;
        for (let s = 0; s + n <= f.length; s++) {
            let ok = true;
            for (let k = 0; k < n; k++) if (f[s + k].w !== words[k]) { ok = false; break; }
            if (ok) for (let k = 0; k < n; k++) marks[f[s + k].i] = Math.max(marks[f[s + k].i], muc);
        }
    };

    for (const h of hits) {
        if (h.tu.indexOf("(viết tách)") >= 0) {
            // đánh dấu các cụm ≥ 4 chữ cái đơn liền nhau
            let run = [];
            const flush = () => { if (run.length >= 4) run.forEach(i => { marks[i] = Math.max(marks[i], h.muc); }); run = []; };
            toks.forEach((t, i) => { if (plainW[i].length === 1 && plainW[i][0].length === 1) run.push(i); else flush(); });
            flush();
            continue;
        }
        if (h.tu.indexOf("(") >= 0) continue;
        const words = h.tu.split(" ").filter(Boolean);
        if (!words.length) continue;
        if (/[^\x00-\x7f]/.test(h.tu)) markPhrase(fa, words, h.muc); else markPhrase(fp, words, h.muc);
    }
    return toks.map((t, i) => ({ t, m: marks[i] }));
}

export function buildExplain({ message, l1, ml, mlActive, l2, risk, prevScore, clarify, topic, sample, telegram }) {
    const hits = [], seen = {}, notes = [];
    for (const m of l1.matches || []) {
        if (m.tu.charAt(0) === "(") { notes.push(m.tu.replace(/^\(|\)$/g, "")); continue; }
        if (seen[m.tu]) continue;
        seen[m.tu] = 1;
        hits.push({ tu: m.tu, muc: m.muc });
    }
    const mlInfo = ml
        ? { active: true, level: ml.level, prob: ml.prob, ms: ml.ms }
        : { active: !!mlActive };
    const l2Info = l2
        ? { level: l2.level, topic: TOPICS[topic] || "Khác", reason: l2.reason, ms: l2.ms }
        : { error: true };
    return {
        words: highlightTokens(message, hits),
        l1: { level: l1.level, ms: l1.ms, hits, notes },
        ml: mlInfo,
        l2: l2Info,
        combine: {
            messageLevel: risk.messageLevel, finalLevel: risk.finalLevel, prevScore: Math.round((prevScore || 0) * 10) / 10,
            score: risk.score, trend: risk.trend, decay: DECAY, weight: LEVEL_WEIGHT[risk.messageLevel], threshold: TREND_THRESHOLD
        },
        clarify: { on: !!clarify.on, reason: clarify.reason || "" },
        telegram: telegram || "no",   // sample | sent | recent | off | error | no
        sample: !!sample
    };
}
