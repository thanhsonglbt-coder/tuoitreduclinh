// tệp: /api/chat.js
import { GoogleGenerativeAI } from "@google/generative-ai";

export default async function handler(req, res) {
    // Cấu hình Header cho phép nhận diện dữ liệu giao diện và chặn lỗi CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Chương trình chỉ hỗ trợ phương thức POST" });
    }

    try {
        const { message, history } = req.body;
        
        // Lấy API Key bí mật được lưu trên cấu hình đám mây Vercel của bạn
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: "Hệ thống chưa thiết lập cấu hình GEMINI_API_KEY" });
        }

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            systemInstruction: "Bạn là chuyên gia tư vấn tâm lý học đường mang tên 'Bạn Đồng Hành'. Hãy luôn lắng nghe học sinh với thái độ ấm áp, đồng cảm, nhẹ nhàng và tuyệt đối không phán xét. Nhiệm vụ của bạn là lắng nghe áp lực học tập, thi cử hoặc mâu thuẫn bạn bè của học sinh cấp 2, cấp 3. Hãy đưa ra câu trả lời ngắn gọn (tối đa 3-4 câu), tập trung xoa dịu cảm xúc và đặt câu hỏi gợi mở để học sinh tâm sự tiếp. Nếu phát hiện học sinh có dấu hiệu muốn tự hại nghiêm trọng, hãy khuyên học sinh gọi ngay hotline hỗ trợ con người ở cuối trang web."
        });

        // Định dạng lại chuỗi hội thoại lịch sử truyền lên từ giao diện
        const formattedHistory = (history || []).map(msg => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.parts[0].text }]
        }));

        const chat = model.startChat({
            history: formattedHistory,
            generationConfig: { temperature: 0.7, maxOutputTokens: 250 }
        });

        const result = await chat.sendMessage(message);
        const response = await result.response;
        const text = response.text();

        return res.status(200).json({ text });
    } catch (error) {
        console.error("Lỗi xử lý máy chủ:", error);
        return res.status(500).json({ error: error.message || "Lỗi xử lý AI nội bộ" });
    }
}