// tệp: /api/chat.js
import { GoogleGenerativeAI } from "@google/generative-ai";

export default async function handler(req, res) {
    // ⚙️ Cấu hình bảo mật CORS - Chỉ cho phép tên miền chính thức của bạn truy cập dữ liệu máy chủ
    res.setHeader('Access-Control-Allow-Origin', 'https://tuoitreduclinh.io.vn');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Xử lý gói tin kiểm tra kết nối (Preflight request) từ trình duyệt
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Chặn tất cả các phương thức truy cập trái phép ngoài hành vi gửi tin nhắn (POST)
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Chương trình chỉ hỗ trợ phương thức POST" });
    }

    try {
        const { message, history } = req.body;
        
        // 🔒 Hệ thống nạp tự động API Key bí mật ẩn từ biến đám mây trên Vercel của bạn
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: "Hệ thống máy chủ chưa thiết lập cấu hình biến GEMINI_API_KEY" });
        }

        const genAI = new GoogleGenerativeAI(apiKey);
        
        // Thiết lập cấu hình chuyên sâu định hình tính cách chuyên gia tâm lý học đường cho mô hình Gemini 1.5 Flash
        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            systemInstruction: "Bạn là chuyên gia tư vấn tâm lý học đường mang tên 'Bạn Đồng Hành'. Hãy luôn lắng nghe học sinh với thái độ ấm áp, đồng cảm, nhẹ nhàng và tuyệt đối không phán xét. Nhiệm vụ của bạn là lắng nghe áp lực học tập, thi cử hoặc mâuthuẫn bạn bè của học sinh cấp 2, cấp 3. Hãy đưa ra câu trả lời ngắn gọn (tối đa 3-4 câu), tập trung xoa dịu cảm xúc và đặt câu hỏi gợi mở để học sinh tâm sự tiếp. Nếu phát hiện học sinh có dấu hiệu muốn tự hại nghiêm trọng, hãy khuyên học sinh gọi ngay hotline hỗ trợ con người ở cuối trang web."
        });

        // Định dạng và làm sạch chuỗi cấu trúc lịch sử hội thoại liên tục gửi lên từ giao diện người dùng
        const formattedHistory = (history || []).map(msg => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.parts[0].text }]
        }));

        // Khởi động luồng chat ghi nhớ ngữ cảnh thông minh của Google SDK
        const chat = model.startChat({
            history: formattedHistory,
            generationConfig: { 
                temperature: 0.7, 
                maxOutputTokens: 250 
            }
        });

        // Chuyển tiếp câu tâm sự của học sinh vào luồng xử lý của AI
        const result = await chat.sendMessage(message);
        const response = await result.response;
        const text = response.text();

        // Trả kết quả chữ hoàn chỉnh về cho giao diện hiển thị
        return res.status(200).json({ text });
    } catch (error) {
        console.error("Lỗi xử lý hệ thống phía máy chủ Backend:", error);
        return res.status(500).json({ error: error.message || "Lỗi xử lý AI nội bộ" });
    }
}
