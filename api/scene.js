// /api/scene — Anthropic API 프록시 (API 키는 서버 환경변수에만 보관)
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY가 설정되지 않았어요. Vercel 환경변수를 확인하세요." });
    return;
  }

  // Vercel Node 런타임에서 req.body가 문자열로 들어오는 경우를 방어
  let payload = req.body;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { payload = null; }
  }
  if (!payload || typeof payload !== "object") {
    res.status(400).json({ error: "요청 본문이 비어있거나 JSON 형식이 아니에요." });
    return;
  }

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      // 디버깅을 위해 Anthropic의 실제 에러 메시지를 그대로 전달
      res.status(upstream.status);
      res.setHeader("Content-Type", "application/json");
      res.send(text);
      return;
    }
    res.status(200);
    res.setHeader("Content-Type", "application/json");
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: "Anthropic API 호출에 실패했어요.", detail: String(e) });
  }
}
