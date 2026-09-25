// tệp: /api/booking.js — Học sinh đặt lịch gặp thầy cô tư vấn (ẩn danh) và tra cứu phản hồi bằng mã hẹn

import { redis, redisConfig, setCors, readBody, cleanText, TOPICS } from "./_lib.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // bỏ các ký tự dễ nhầm: I, O, 0, 1

function makeCode() {
    let s = "";
    for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return "TV-" + s;
}

export const STATUS_TEXT = {
    moi: "Đã gửi, đang chờ thầy cô xem",
    da_hen: "Thầy cô đã sắp xếp lịch gặp",
    da_gap: "Đã gặp tư vấn",
    huy: "Đã hủy"
};

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

        // ===== ĐẶT LỊCH MỚI =====
        if (req.method === "POST") {
            const body = readBody(req);
            const booking = {
                nickname: cleanText(body.nickname, 40),
                contact: cleanText(body.contact, 100),
                topic: TOPICS[body.topic] ? body.topic : "khac",
                preferred: cleanText(body.preferred, 100),
                note: cleanText(body.note, 600)
            };

            // Tạo mã không trùng
            let code = makeCode();
            for (let i = 0; i < 5; i++) {
                const [exists] = await redis([["HEXISTS", "bookings", code]]);
                if (!exists) break;
                code = makeCode();
            }
            const record = Object.assign({ code, t: Date.now(), status: "moi", reply: "" }, booking);
            await redis([["HSET", "bookings", code, JSON.stringify(record)]]);
            return res.status(200).json({ code });
        }

        return res.status(405).json({ error: "Phương thức không hỗ trợ" });
    } catch (error) {
        console.error("Lỗi đặt lịch:", error);
        return res.status(500).json({ error: error.message || "Lỗi hệ thống đặt lịch" });
    }
}