export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  ALLOWED_USER_IDS: string;
  RESEND_API_KEY: string;
  FROM_EMAIL: string;
  KINDLE_EMAIL: string;
  KINDLE_BOT_KV: KVNamespace; // 绑定 Cloudflare KV 命名空间以实现去重
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 1. 仅允许 POST 请求（Telegram Webhook 默认是 POST）
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let chatId: number | undefined = undefined;

    try {
      const update: any = await request.json();
      const message = update.message;

      // 如果不是合法的消息，直接返回
      if (!message) {
        return new Response("OK", { status: 200 });
      }

      chatId = message.chat.id;
      const userId = message.from?.id;

      // 2. 安全过滤：拦截非白名单用户
      const allowedUsers = env.ALLOWED_USER_IDS.split(",").map(id => id.trim());
      if (!userId || !allowedUsers.includes(userId.toString())) {
        console.warn(`Unauthorized access attempt from User ID: ${userId}`);
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "❌ 您没有权限使用此 Bot。");
        return new Response("Unauthorized", { status: 200 }); // 返回 200 防止 TG 反复重试 Webhook
      }

      // 3. 解析消息类型：必须是 Document 类型（文件类型）
      const document = message.document;
      if (!document) {
        // 如果是普通文本，回复提示并引导用户发送书籍文件
        if (message.text === "/start") {
          await sendTelegramMessage(
            env.TELEGRAM_BOT_TOKEN,
            chatId,
            "📚 欢迎使用 Kindle 自动推送 Bot！\n\n请直接将您的电子书（支持 .epub, .pdf 等格式）作为“文件/文档”发送给我，我将自动帮您推送到您的 Kindle 设备。"
          );
        } else {
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "ℹ️ 请发送电子书文件（如 .epub 格式的文档），而不是普通文字消息。");
        }
        return new Response("OK", { status: 200 });
      }

      const fileId = document.file_id;
      const fileUniqueId = document.file_unique_id; // Telegram 提供的文件全局唯一指纹
      const fileName = document.file_name || "book.epub";
      const fileSize = document.file_size || 0;

      // 4. 格式白名单校验 (Allowed Extensions Whitelist)
      // 仅允许亚马逊 Kindle 官方认可的书籍、文档和图片格式
      const ALLOWED_EXTENSIONS = ["epub", "pdf", "txt", "doc", "docx", "html", "htm", "rtf", "jpg", "jpeg", "png", "gif", "bmp", "prc"];
      const fileExtension = fileName.split('.').pop()?.toLowerCase();

      if (!fileExtension || !ALLOWED_EXTENSIONS.includes(fileExtension)) {
        await sendTelegramMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          `⚠️ 抱歉，亚马逊 Kindle 官方不支持推送 .${fileExtension || "未知"} 格式的书籍。\n\n📚 目前支持的格式有：\n• 推荐格式：.epub (排版最佳)\n• 其他文档：.pdf, .txt, .doc, .docx, .html, .rtf\n• 支持图片：.jpg, .jpeg, .png, .gif, .bmp\n\n💡 如果是 .mobi 或 .azw3，建议您先在电脑端 Calibre 中一键转换为 .epub 再发送！`
        );
        return new Response("OK", { status: 200 });
      }

      // 5. 大文件检测限制
      const MAX_SIZE_MB = 20;
      if (fileSize > MAX_SIZE_MB * 1024 * 1024) {
        await sendTelegramMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          `⚠️ 抱歉，Telegram 限制普通 Bot 只能下载 ${MAX_SIZE_MB}MB 以下的文件。当前文件大小为 ${(fileSize / 1024 / 1024).toFixed(2)}MB，无法处理。`
        );
        return new Response("OK", { status: 200 });
      }

      // 6. 全局去重校验：查询指纹数据库中是否已存在
      if (fileUniqueId) {
        const isAlreadySent = await env.KINDLE_BOT_KV.get(fileUniqueId);
        if (isAlreadySent) {
          await sendTelegramMessage(
            env.TELEGRAM_BOT_TOKEN,
            chatId,
            `ℹ️ 这本书《${fileName}》您之前已经成功推送过了，无需重复发送。`
          );
          return new Response("OK", { status: 200 });
        }
      }

      // 7. 状态反馈：通知用户正在处理中
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `⏳ 正在从 Telegram 接收书籍《${fileName}》并准备推送到 Kindle，请稍候...`);

      // 8. 下载图书文件
      // 8.1 获取文件下载路径
      const fileInfoResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
      if (!fileInfoResponse.ok) {
        throw new Error(`获取 TG 文件路径失败: ${fileInfoResponse.statusText}`);
      }
      const fileInfoData: any = await fileInfoResponse.json();
      if (!fileInfoData.ok) {
        throw new Error(`TG getFile 接口返回异常: ${fileInfoData.description}`);
      }
      const filePath = fileInfoData.result.file_path;

      // 8.2 真实下载二进制文件数据
      const fileDownloadUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;
      const fileResponse = await fetch(fileDownloadUrl);
      if (!fileResponse.ok) {
        throw new Error(`从 TG 下载文件二进制流失败: ${fileResponse.statusText}`);
      }

      const fileArrayBuffer = await fileResponse.arrayBuffer();

      // 9. 二进制流转为 Base64 编码 (Resend API 要求格式)
      const base64Content = arrayBufferToBase64(fileArrayBuffer);

      // 10. 构造并发送邮件 (调用 Resend API)
      const emailResponse = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: env.FROM_EMAIL,
          to: [env.KINDLE_EMAIL],
          subject: `Deliver Book: ${fileName}`,
          text: `Here is your book: ${fileName}. Powered by localVPS Serverless Bot.`,
          attachments: [
            {
              filename: fileName,
              content: base64Content
            }
          ]
        })
      });

      if (!emailResponse.ok) {
        const errText = await emailResponse.text();
        throw new Error(`Resend 邮件投递失败: ${errText}`);
      }

      const emailResult: any = await emailResponse.json();
      console.log(`Email sent successfully, ID: ${emailResult.id}`);

      // 11. 去重归档：将发送成功的文件指纹写入 KV 数据库（记录发送时间）
      if (fileUniqueId) {
        await env.KINDLE_BOT_KV.put(fileUniqueId, new Date().toISOString());
      }

      // 12. 推送成功反馈
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, `✅ 《${fileName}》发送成功！正在通过亚马逊云端同步到您的 Kindle，请在数分钟内注意设备更新。`);

      return new Response("OK", { status: 200 });
    } catch (error: any) {
      console.error(`Error processing Webhook:`, error);
      // 物理异常弹回给用户，提供极佳的交互回执
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        `❌ 图书推送失败。\n\n原因：${error.message || error || "未知接口异常"}\n请核对您的 Resend 配置或稍后重试。`
      );
      return new Response("Error processed internally", { status: 200 });
    }
  }
};

/**
 * 辅助函数：向 Telegram 对应 Chat 发送文本消息
 */
async function sendTelegramMessage(token: string, chatId: number | undefined, text: string): Promise<void> {
  if (!chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text
    })
  });
}

/**
 * 辅助函数：将 ArrayBuffer 高效转换为 Base64 字符串
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
