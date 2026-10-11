// Syzygy 信箱的 Cloudflare Email Worker（syzygy@syzygycc.com）。
//
// 只做一件事：把收到的原始邮件原样转给 Supabase 的 mail-ingest，解析、白名单、落库都在那边。
// 部署：Cloudflare 后台 → Workers 和 Pages → 创建 Worker，把本文件整个贴进去；
//       再到 syzygycc.com → 电子邮件 → 电子邮件路由 → 路由规则，把 syzygy@ 的动作设为「发送到 Worker」。
// 需要在 Worker 的「设置 → 变量和机密」里配置：
//   MAIL_INGEST_URL     https://<project-ref>.supabase.co/functions/v1/mail-ingest（普通变量）
//   MAIL_INGEST_SECRET  与 Supabase Function secret 同名同值（机密）

const MAX_RAW_BYTES = 10 * 1024 * 1024

export default {
  async email(message, env) {
    if (message.rawSize > MAX_RAW_BYTES) {
      message.setReject('Message too large for this mailbox.')
      return
    }

    const raw = await new Response(message.raw).arrayBuffer()
    const response = await fetch(env.MAIL_INGEST_URL, {
      method: 'POST',
      headers: {
        'content-type': 'message/rfc822',
        'x-mail-ingest-secret': env.MAIL_INGEST_SECRET,
        'x-mail-envelope-from': message.from,
        'x-mail-envelope-to': message.to,
      },
      body: raw,
    })

    // 名单外、太大、解析不了：退信。其余失败抛错，让 Cloudflare 按临时失败处理。
    if (response.status === 403) {
      message.setReject('This mailbox only accepts mail from its owner.')
      return
    }
    if (response.status === 413 || response.status === 400) {
      message.setReject('This message could not be accepted.')
      return
    }
    if (!response.ok) {
      throw new Error(`mail-ingest responded ${response.status}`)
    }
  },
}
