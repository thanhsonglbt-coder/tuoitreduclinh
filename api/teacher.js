// tệp: /api/teacher.js — API cho Trang giáo viên (cần mật khẩu TEACHER_PASSWORD đặt trên Vercel)
// Chức năng: thống kê, quản lý lịch hẹn, sửa kiến thức trường, kiểm thử bộ phát hiện nguy cơ.

import {
    redis, redisConfig, hashToObject, weekInfo, setCors, readBody, cleanText,
    detectKeywords, classifyAI, combineRisk, getKnowledge, DEFAULT_KNOWLEDGE, TOPICS
} from "./_lib.js";

const STATUSES = ["moi", "da_hen", "da_gap", "huy"];

function checkPassword(req) {
    const pw = (process.env.TEACHER_PASSWORD || "").trim();
    if (!pw) return "Chưa đặt mật khẩu TEACHER_PASSWORD trên Vercel";
    const given = String(req.headers["x-teacher-password"] || "");
    if (given !== pw) return "Sai mật khẩu";
    return null;
}

function needDb() {
    if (!redisConfig()) throw new Error("Chưa kết nối cơ sở dữ liệu (Upstash Redis). Xem hướng dẫn cài đặt.");
}

async function getStats(weeks) {
    needDb();
    const list = [];
    for (let i = weeks - 1; i >= 0; i--) list.push(weekInfo(Date.now() - i * 7 * 86400000));
    const cmds = [];
    for (const w of list) {
        cmds.push(["HGETALL", `stats:${w.key}:topic`]);
        cmds.push(["HGETALL", `stats:${w.key}:level`]);
        cmds.push(["SCARD", `stats:${w.key}:conv`]);
        cmds.push(["SCARD", `stats:${w.key}:flag`]);
    }
    cmds.push(["LRANGE", "alerts", 0, 99]);
    cmds.push(["HVALS", "bookings"]);
    const r = await redis(cmds);

    const out = list.map((w, i) => {
        const topicsRaw = hashToObject(r[i * 4]);
        const levelsRaw = hashToObject(r[i * 4 + 1]);
        const topics = {};
        for (const k of Object.keys(TOPICS)) topics[k] = Number(topicsRaw[k] || 0);
        const levels = [0, 1, 2, 3].map(l => Number(levelsRaw[l] || 0));
        return {
            key: w.key, label: w.label, topics, levels,
            messages: levels.reduce((a, b) => a + b, 0),
            conversations: Number(r[i * 4 + 2] || 0),
            flagged: Number(r[i * 4 + 3] || 0)
        };
    });
    const alerts = (r[list.length * 4] || []).map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
    const bookings = (r[list.length * 4 + 1] || []).map(s => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
    return {
        weeks: out,
        alerts,
        bookingsNew: bookings.filter(b => b.status === "moi").length,
        topicNames: TOPICS
    };
}

export default async function handler(req, res) {
    setCors(res);
    if (req.method === "OPTIONS") return res.status(200).end();

    const authError = checkPassword(req);
    if (authError) return res.status(401).json({ error: authError });

    try {
        const q = req.query || {};
        const body = req.method === "POST" ? readBody(req) : {};
        const action = req.method === "GET" ? q.action : body.action;

        // Kiểm tra đăng nhập
        if (action === "ping") {
            return res.status(200).json({ ok: true, db: !!redisConfig() });
        }

        // Thống kê
        if (action === "stats") {
            const weeks = Math.min(26, Math.max(1, parseInt(q.weeks, 10) || 8));
            return res.status(200).json(await getStats(weeks));
        }

        // Danh sách lịch hẹn
        if (action === "bookings") {
            needDb();
            const [vals] = await redis([["HVALS", "bookings"]]);
            const list = (vals || []).map(s => { try { return JSON.parse(s); } catch (e) { return null; } })
                .filter(Boolean).sort((a, b) => b.t - a.t);
            return res.status(200).json({ bookings: list, topicNames: TOPICS });
        }

        // Cập nhật lịch hẹn (trạng thái + lời nhắn cho học sinh)
        if (action === "booking_update") {
            needDb();
            const code = cleanText(body.code, 20);
            const [raw] = await redis([["HGET", "bookings", code]]);
            if (!raw) return res.status(404).json({ error: "Không tìm thấy lịch hẹn" });
            const b = JSON.parse(raw);
            if (STATUSES.includes(body.status)) b.status = body.status;
            if (body.reply !== undefined) b.reply = cleanText(body.reply, 600);
            b.updatedAt = Date.now();
            await redis([["HSET", "bookings", code, JSON.stringify(b)]]);
            return res.status(200).json({ ok: true, booking: b });
        }

        // Xóa lịch hẹn
        if (action === "booking_delete") {
            needDb();
            await redis([["HDEL", "bookings", cleanText(body.code, 20)]]);
            return res.status(200).json({ ok: true });
        }

        // Kiến thức trường
        if (action === "kb") {
            const kb = await getKnowledge();
            return res.status(200).json({ text: kb.text, isDefault: kb.isDefault, defaultText: DEFAULT_KNOWLEDGE });
        }
        if (action === "kb_save") {
            needDb();
            const text = cleanText(body.text, 15000);
            if (!text) await redis([["DEL", "kb:school"]]);
            else await redis([["SET", "kb:school", text]]);
            return res.status(200).json({ ok: true });
        }

        // KIỂM THỬ bộ phát hiện nguy cơ: chạy lớp 1, lớp 2 và kết hợp cho 1 câu (không ghi thống kê)
        if (action === "classify") {
            const message = cleanText(body.message, 2000);
            if (!message) return res.status(400).json({ error: "Câu trống" });
            const l1 = detectKeywords(message);
            let l2 = null, l2Error = null;
            try { l2 = await classifyAI(message, []); } catch (e) { l2Error = e.message; }
            const combined = combineRisk(l1.level, l2 ? l2.level : null, 0);
            return res.status(200).json({
                l1: { level: l1.level, matches: l1.matches, ms: l1.ms },
                l2: l2 ? { level: l2.level, topic: l2.topic, reason: l2.reason, model: l2.model, ms: l2.ms } : null,
                l2Error,
                combined: combined.messageLevel
            });
        }

        return res.status(400).json({ error: "Thao tác không hợp lệ" });
    } catch (error) {
        console.error("Lỗi trang giáo viên:", error);
        return res.status(500).json({ error: error.message || "Lỗi máy chủ" });
    }
}