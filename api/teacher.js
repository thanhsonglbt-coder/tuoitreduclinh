// tệp: /api/teacher.js — API cho Trang giáo viên (cần mật khẩu giáo viên)
// Chức năng: đăng nhập, đổi mật khẩu, thống kê, quản lý lịch hẹn, sửa kiến thức trường, kiểm thử bộ phát hiện nguy cơ.

import crypto from "crypto";
import {
    redis, redisConfig, hashToObject, weekInfo, setCors, readBody, cleanText,
    detectKeywords, classifyAI, combineRisk, getKnowledge, DEFAULT_KNOWLEDGE, TOPICS,
    LEXICON, LEXICON_V2_EXTRA, getCustomLexicon, invalidateCustomLexicon, normalizeEntry
} from "./_lib.js";

const MAX_ITEMS = 2000;   // số dòng tối đa của một bộ dữ liệu
const MAX_RUNS = 60;      // số lần kiểm thử được lưu
const newId = () => crypto.randomBytes(5).toString("hex");
const parseAll = vals => (vals || []).map(v => { try { return JSON.parse(v); } catch (e) { return null; } }).filter(Boolean);

const STATUSES = ["moi", "da_hen", "da_gap", "huy"];

/* ===== MẬT KHẨU GIÁO VIÊN =====
   - Mật khẩu GỐC: biến TEACHER_PASSWORD trên Vercel. Luôn đăng nhập được, dùng để khôi phục khi quên.
   - Mật khẩu RIÊNG: giáo viên tự đổi trên trang /doimatkhau.html, lưu trong cơ sở dữ liệu
     dưới dạng đã mã hóa một chiều (scrypt + salt), không ai đọc lại được mật khẩu thật.
   - Nhập sai quá 10 lần trong 15 phút thì tạm khóa. */
const PW_KEY = "auth:teacher";
const MAX_FAILS = 10;

function hashPassword(pw, salt) {
    return crypto.scryptSync(String(pw), salt, 32).toString("hex");
}
function safeEqual(a, b) {
    const A = Buffer.from(String(a)), B = Buffer.from(String(b));
    return A.length === B.length && crypto.timingSafeEqual(A, B);
}

async function checkPassword(req) {
    const master = (process.env.TEACHER_PASSWORD || "").trim();
    const given = String(req.headers["x-teacher-password"] || "");
    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
    const failKey = "auth:fail:" + ip.replace(/[^a-zA-Z0-9.:]/g, "").slice(0, 60);

    let stored = null;
    if (redisConfig()) {
        try {
            const [s, fails] = await redis([["GET", PW_KEY], ["GET", failKey]]);
            stored = s;
            if (Number(fails) >= MAX_FAILS) {
                return { error: "Nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.", status: 429 };
            }
        } catch (e) {
            console.error("Không đọc được mật khẩu riêng:", e.message);
        }
    }
    if (!master && !stored) return { error: "Chưa đặt mật khẩu TEACHER_PASSWORD trên Vercel", status: 401 };

    let via = null;
    if (given && stored) {
        const [salt, hash] = String(stored).split(":");
        if (salt && hash && safeEqual(hashPassword(given, salt), hash)) via = "rieng";
    }
    if (!via && given && master && safeEqual(given, master)) via = "goc";

    if (!via) {
        if (redisConfig()) {
            try { await redis([["INCR", failKey], ["EXPIRE", failKey, 900]]); } catch (e) {}
        }
        return { error: "Sai mật khẩu", status: 401 };
    }
    return { ok: true, via, hasCustom: !!stored };
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

    const auth = await checkPassword(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    try {
        const q = req.query || {};
        const body = req.method === "POST" ? readBody(req) : {};
        const action = req.method === "GET" ? q.action : body.action;

        // Kiểm tra đăng nhập
        if (action === "ping") {
            return res.status(200).json({ ok: true, db: !!redisConfig(), via: auth.via, hasCustom: auth.hasCustom });
        }

        // Đổi mật khẩu (phải đăng nhập bằng mật khẩu hiện tại mới gọi được)
        if (action === "change_password") {
            needDb();
            const newPw = String(body.newPassword || "");
            if (newPw.length < 8) return res.status(400).json({ error: "Mật khẩu mới phải có ít nhất 8 ký tự" });
            if (newPw.length > 100) return res.status(400).json({ error: "Mật khẩu mới quá dài (tối đa 100 ký tự)" });
            if (newPw.trim() !== newPw) return res.status(400).json({ error: "Mật khẩu không được có khoảng trắng ở đầu hoặc cuối" });
            const salt = crypto.randomBytes(16).toString("hex");
            await redis([["SET", PW_KEY, salt + ":" + hashPassword(newPw, salt)]]);
            return res.status(200).json({ ok: true });
        }

        // Bỏ mật khẩu riêng, quay về chỉ dùng mật khẩu gốc TEACHER_PASSWORD
        if (action === "reset_password") {
            needDb();
            await redis([["DEL", PW_KEY]]);
            return res.status(200).json({ ok: true });
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
            // context: các tin nhắn trước trong cùng kịch bản hội thoại (dùng cho tab "Tối ưu tham số")
            const context = Array.isArray(body.context) ? body.context.slice(-4).map(x => cleanText(x, 2000)).filter(Boolean) : [];
            const l1 = detectKeywords(message, 2, await getCustomLexicon());
            const l1v1 = detectKeywords(message, 1); // bản gốc, để so sánh trước/sau cải tiến
            let l2 = null, l2Error = null;
            try { l2 = await classifyAI(message, context); } catch (e) { l2Error = e.message; }
            const combined = combineRisk(l1.level, l2 ? l2.level : null, 0);
            return res.status(200).json({
                l1: { level: l1.level, matches: l1.matches, ms: l1.ms },
                l1v1: { level: l1v1.level, matches: l1v1.matches },
                l2: l2 ? { level: l2.level, topic: l2.topic, reason: l2.reason, model: l2.model, ms: l2.ms } : null,
                l2Error,
                combined: combined.messageLevel
            });
        }

        /* ===== KHO BỘ DỮ LIỆU KIỂM THỬ =====
           type "cau": mỗi dòng {text, label 0–3, group} · type "kichban": mỗi dòng {text "tin 1 >> tin 2", label 0/1} */
        if (action === "datasets_list") {
            needDb();
            const [vals] = await redis([["HVALS", "datasets"]]);
            const list = parseAll(vals).map(d => ({ id: d.id, name: d.name, type: d.type, desc: d.desc || "", count: (d.items || []).length, updatedAt: d.updatedAt }))
                .sort((a, b) => b.updatedAt - a.updatedAt);
            return res.status(200).json({ datasets: list });
        }
        if (action === "dataset_get") {
            needDb();
            const [raw] = await redis([["HGET", "datasets", cleanText(q.id || body.id, 20)]]);
            if (!raw) return res.status(404).json({ error: "Không tìm thấy bộ dữ liệu" });
            return res.status(200).json({ dataset: JSON.parse(raw) });
        }
        if (action === "dataset_save") {
            needDb();
            const type = body.type === "kichban" ? "kichban" : "cau";
            const name = cleanText(body.name, 80);
            if (!name) return res.status(400).json({ error: "Bộ dữ liệu cần có tên" });
            const items = (Array.isArray(body.items) ? body.items : []).slice(0, MAX_ITEMS).map(it => {
                const text = cleanText(it && it.text, type === "kichban" ? 3000 : 1000);
                let label = parseInt(it && it.label, 10);
                if (!(label >= 0 && label <= (type === "kichban" ? 1 : 3))) label = null;
                return { text, label, group: cleanText(it && it.group, 60) };
            }).filter(it => it.text);
            const id = /^[a-f0-9]{10}$/.test(String(body.id || "")) ? body.id : newId();
            const record = { id, name, type, desc: cleanText(body.desc, 300), items, updatedAt: Date.now() };
            await redis([["HSET", "datasets", id, JSON.stringify(record)]]);
            return res.status(200).json({ ok: true, id, count: items.length });
        }
        if (action === "dataset_delete") {
            needDb();
            await redis([["HDEL", "datasets", cleanText(body.id, 20)]]);
            return res.status(200).json({ ok: true });
        }

        /* ===== LỊCH SỬ KẾT QUẢ KIỂM THỬ ===== */
        if (action === "runs_list") {
            needDb();
            const [vals] = await redis([["HVALS", "runs"]]);
            const list = parseAll(vals).map(r => { const c = Object.assign({}, r); delete c.rows; return c; }).sort((a, b) => b.t - a.t);
            return res.status(200).json({ runs: list });
        }
        if (action === "run_get") {
            needDb();
            const [raw] = await redis([["HGET", "runs", cleanText(q.id || body.id, 20)]]);
            if (!raw) return res.status(404).json({ error: "Không tìm thấy kết quả" });
            return res.status(200).json({ run: JSON.parse(raw) });
        }
        if (action === "run_save") {
            needDb();
            const run = body.run || {};
            const record = {
                id: newId(), t: Date.now(),
                kind: run.kind === "tune" ? "tune" : "test",
                dataset: cleanText(run.dataset, 80) || "(dán trực tiếp)",
                n: Number(run.n) || 0,
                models: (Array.isArray(run.models) ? run.models : []).slice(0, 6).map(m => cleanText(m, 60)),
                note: cleanText(run.note, 300),
                summary: run.summary || {},
                rows: Array.isArray(run.rows) ? run.rows.slice(0, MAX_ITEMS) : []
            };
            let json = JSON.stringify(record);
            if (json.length > 800000) { record.rows = []; record.rowsDropped = true; json = JSON.stringify(record); }
            await redis([["HSET", "runs", record.id, json]]);
            // Giữ tối đa MAX_RUNS lần gần nhất
            const [vals] = await redis([["HVALS", "runs"]]);
            const all = parseAll(vals).sort((a, b) => b.t - a.t);
            if (all.length > MAX_RUNS) await redis(all.slice(MAX_RUNS).map(r => ["HDEL", "runs", r.id]));
            return res.status(200).json({ ok: true, id: record.id });
        }
        if (action === "run_delete") {
            needDb();
            await redis([["HDEL", "runs", cleanText(body.id, 20)]]);
            return res.status(200).json({ ok: true });
        }

        /* ===== TỪ ĐIỂN TÙY CHỈNH ===== */
        if (action === "lexicon_get") {
            const custom = await getCustomLexicon(true);
            const builtin = [3, 2, 1].map(lv => ({
                muc: lv,
                v1: LEXICON[lv].plain.concat(LEXICON[lv].accent),
                v2: LEXICON_V2_EXTRA[lv].plain.concat(LEXICON_V2_EXTRA[lv].accent)
            }));
            return res.status(200).json({ builtin, custom: custom.sort((a, b) => b.t - a.t) });
        }
        if (action === "lexicon_add") {
            needDb();
            const tu = cleanText(body.tu, 80);
            const muc = parseInt(body.muc, 10);
            const accent = !!body.accent;
            if (!tu) return res.status(400).json({ error: "Chưa nhập từ hoặc cụm từ" });
            if (!(muc >= 0 && muc <= 3)) return res.status(400).json({ error: "Mức phải từ 0 đến 3" });
            const norm = normalizeEntry(tu, accent);
            if (norm.replace(/\s/g, "").length < 2) return res.status(400).json({ error: "Từ khóa quá ngắn, dễ báo nhầm" });
            const field = (accent ? "a:" : "p:") + norm;
            await redis([["HSET", "lexicon:custom", field, JSON.stringify({ field, tu, norm, muc, accent, note: cleanText(body.note, 200), t: Date.now() })]]);
            invalidateCustomLexicon();
            return res.status(200).json({ ok: true, norm });
        }
        if (action === "lexicon_delete") {
            needDb();
            await redis([["HDEL", "lexicon:custom", cleanText(body.field, 200)]]);
            invalidateCustomLexicon();
            return res.status(200).json({ ok: true });
        }
        // Thử nhanh bộ lọc lớp 1 (không gọi AI)
        if (action === "l1_test") {
            const message = cleanText(body.message, 2000);
            if (!message) return res.status(400).json({ error: "Câu trống" });
            const v2 = detectKeywords(message, 2, await getCustomLexicon(true));
            const v1 = detectKeywords(message, 1);
            return res.status(200).json({ v1: { level: v1.level, matches: v1.matches }, v2: { level: v2.level, matches: v2.matches } });
        }

        return res.status(400).json({ error: "Thao tác không hợp lệ" });
    } catch (error) {
        console.error("Lỗi trang giáo viên:", error);
        return res.status(500).json({ error: error.message || "Lỗi máy chủ" });
    }
}
