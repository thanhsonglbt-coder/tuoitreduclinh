// tệp: /api/booking.js — Học sinh đặt lịch gặp thầy cô tư vấn (ẩn danh), tự nguyện để lại liên lạc,
// tra cứu phản hồi bằng mã hẹn, và ghi nhận ẩn danh các hành động sau cảnh báo (bấm gọi 111, trả lời "có an toàn không").

import {
    redis, redisConfig, setCors, readBody, cleanText, TOPICS,
    getAlertLevel, countFollowup, sendTelegram, telegramConfig, safeCidOf, vnTime
} from "./_lib.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // bỏ các ký tự dễ nhầm: I, O, 0, 1

function makeCode() {
    let s = "";
    for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return "TV-" + s;
}

export const STATUS_TEXT = {
    moi: "Đã gửi, đang chờ thầy cô xem",
    da_hen: "Thầy cô đã sắp xếp lịch gặp",
    da_lien_he: "Thầy cô đã liên hệ với bạn",
    da_gap: "Đã gặp tư vấn",
    huy: "Đã hủy"
};

function clientIp(req) {
    const xf = (req.headers && req.headers["x-forwarded-for"]) || "";
    return String(xf.split(",")[0] || (req.socket && req.socket.remoteAddress) || "unknown").trim().slice(0, 60);
}

// Chặn gửi ồ ạt: tối đa 8 yêu cầu mỗi giờ từ một địa chỉ mạng (không lưu lâu, chỉ để chống phá)
async function tooMany(req) {
    const key = "rl:bk:" + clientIp(req).replace(/[^a-zA-Z0-9.:]/g, "");
    const [n] = await redis([["INCR", key], ["EXPIRE", key, "3600"]]);
    return Number(n) > 8;
}

export default async function handler(req, res) {
    setCors(res);
    if (req.method === "OPTIONS") return res.status(200).end();

    if (!redisConfig()) {
        return res.status(500).json({ error: "Hệ thống đặt lịch chưa kết nối cơ sở dữ liệu. Bạn hãy báo thầy cô nhé." });
    }

    try {
        // ===== TRA CỨU bằng mã hẹn =====
        if (req.method === "GET") {
            const code = cleanText(req.query && req.query.code, 20).toUpperCase().replace(/\s/g, "");
            if (!/^TV-[A-Z0-9]{6}$/.test(code)) {
                return res.status(400).json({ error: "Mã hẹn không đúng dạng (ví dụ: TV-AB12CD)" });
            }
            const [raw] = await redis([["HGET", "bookings", code]]);
            if (!raw) return res.status(404).json({ error: "Không tìm thấy mã hẹn này" });
            const b = JSON.parse(raw);
            return res.status(200).json({
                code: b.code,
                createdAt: b.t,
                status: b.status,
                statusText: STATUS_TEXT[b.status] || b.status,
                reply: b.reply || "",
                preferred: b.preferred || ""
            });
        }

        if (req.method !== "POST") return res.status(405).json({ error: "Phương thức không hỗ trợ" });
        const body = readBody(req);

        // ===== GHI NHẬN HÀNH ĐỘNG SAU CẢNH BÁO (ẩn danh, chỉ đếm) =====
        if (body.action === "event") {
            const ev = cleanText(body.event, 20);
            if (["call111", "call115", "safe_yes", "safe_no"].includes(ev) && body.cid) {
                const lv = await getAlertLevel(body.cid);
                if (lv >= 2) await countFollowup(body.cid, ev);
                // Học sinh trả lời "chưa an toàn" ngay sau cảnh báo mức 3 → báo thêm cho thầy cô (1 lần / cuộc)
                if (ev === "safe_no" && lv >= 3 && telegramConfig()) {
                    const c = safeCidOf(body.cid);
                    const [ok] = await redis([["SET", `tgsafe:${c}`, "1", "NX", "EX", "7200"]]);
                    if (ok === "OK") {
                        await sendTelegram(`🔴 Học sinh ở cuộc ${c.slice(0, 6)} vừa trả lời: CHƯA AN TOÀN (${vnTime()}).
Hệ thống đã nhắc em gọi 111 và tìm người lớn ở gần. Nếu em để lại liên lạc, thầy cô sẽ nhận thông báo tiếp theo.`);
                    }
                }
            }
            return res.status(200).json({ ok: true });
        }

        // ===== ĐẶT LỊCH MỚI hoặc YÊU CẦU THẦY CÔ LIÊN HỆ =====
        if (await tooMany(req)) {
            return res.status(429).json({ error: "Bạn gửi quá nhiều yêu cầu trong thời gian ngắn. Hãy thử lại sau, hoặc gọi 111 nếu cần giúp ngay." });
        }

        const kind = body.kind === "lien_he" ? "lien_he" : "dat_lich";
        const booking = {
            kind,
            nickname: cleanText(body.nickname, 40),
            contact: cleanText(body.contact, 100),
            topic: TOPICS[body.topic] ? body.topic : "khac",
            preferred: cleanText(body.preferred, 100),
            note: cleanText(body.note, 600)
        };
        if (kind === "lien_he") {
            booking.lop = cleanText(body.lop, 20);
            booking.phone = cleanText(body.phone, 40);
            booking.unsafe = body.unsafe === true || body.unsafe === "1";
            if (!(body.consent === true || body.consent === "1" || body.consent === "on")) {
                return res.status(400).json({ error: "Bạn cần đánh dấu đồng ý để thầy cô liên hệ." });
            }
            if (!booking.lop && !booking.phone) {
                return res.status(400).json({ error: "Hãy để lại ít nhất lớp hoặc số điện thoại/Zalo để thầy cô tìm được bạn." });
            }
        }

        // Yêu cầu này có đến ngay sau một cảnh báo không? (dùng để đo hiệu quả kết nối, không lưu nội dung)
        const fromAlert = body.cid ? await getAlertLevel(body.cid) : 0;
        booking.fromAlert = fromAlert;
        booking.urgent = kind === "lien_he" && (fromAlert >= 3 || booking.unsafe);

        // Tạo mã không trùng
        let code = makeCode();
        for (let i = 0; i < 5; i++) {
            const [exists] = await redis([["HEXISTS", "bookings", code]]);
            if (!exists) break;
            code = makeCode();
        }
        const record = Object.assign({ code, t: Date.now(), status: "moi", reply: "" }, booking);
        await redis([["HSET", "bookings", code, JSON.stringify(record)]]);

        if (fromAlert >= 2) {
            try { await countFollowup(body.cid, kind === "lien_he" ? "contact_sent" : "booking_after"); } catch (e) { }
        }

        // Báo thầy cô qua Telegram — chỉ mã hẹn và mức độ, KHÔNG gửi tên/lớp/số điện thoại qua Telegram
        if (kind === "lien_he" || fromAlert >= 3) {
            const head = booking.urgent ? "🆘 KHẨN – " : "🔔 ";
            const what = kind === "lien_he" ? "Học sinh TỰ NGUYỆN để lại liên lạc, mong thầy cô liên hệ" : "Học sinh đặt lịch gặp tư vấn";
            const host = req.headers && req.headers.host;
            try {
                await sendTelegram(`${head}${what}
Mã hẹn: ${code}
Thời gian: ${vnTime()}
${fromAlert >= 2 ? "Ngay sau cảnh báo mức " + fromAlert + " trong cuộc trò chuyện." : ""}${booking.unsafe ? "\nEm cho biết: CHƯA AN TOÀN." : ""}
Xem thông tin liên lạc trong Trang giáo viên → Lịch hẹn${host ? ": https://" + host + "/giaovien.html" : ""}`);
            } catch (e) { console.error("Telegram:", e.message); }
        }

        return res.status(200).json({ code, urgent: booking.urgent });
    } catch (error) {
        console.error("Lỗi đặt lịch:", error);
        return res.status(500).json({ error: error.message || "Lỗi hệ thống đặt lịch" });
    }
}
