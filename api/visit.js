// tệp: /api/visit.js — Đếm lượt truy cập trang (ẩn danh).
// Mỗi lần mở trang trong một tab chỉ tính 1 lượt (trình duyệt tự nhớ bằng sessionStorage, đóng tab là quên).
// Chỉ lưu CON SỐ theo ngày và theo trang, KHÔNG lưu địa chỉ mạng, mã máy hay bất kỳ thông tin nào về người xem.

import { redis, redisConfig, setCors, readBody, cleanText, vnDay, VISIT_PAGES } from "./_lib.js";

const TTL = String(400 * 86400); // giữ số liệu theo ngày ~13 tháng, giống các thống kê khác

async function readCounts() {
    const [total, today] = await redis([["GET", "visits:total"], ["GET", `visits:day:${vnDay()}`]]);
    return { total: Number(total || 0), today: Number(today || 0) };
}

export default async function handler(req, res) {
    setCors(res);
    if (req.method === "OPTIONS") return res.status(200).end();
    if (!redisConfig()) return res.status(200).json({ total: null, today: null });

    try {
        if (req.method === "POST") {
            const page = cleanText(readBody(req).page, 20);
            const p = VISIT_PAGES.includes(page) ? page : "home";
            const day = vnDay();
            await redis([
                ["INCR", "visits:total"],
                ["INCR", `visits:day:${day}`],
                ["EXPIRE", `visits:day:${day}`, TTL],
                ["HINCRBY", `visits:page:${day}`, p, 1],
                ["EXPIRE", `visits:page:${day}`, TTL]
            ]);
        }
        return res.status(200).json(await readCounts());
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
