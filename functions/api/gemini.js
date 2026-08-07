// Cloudflare Pages Function — Gemini API proxy
// GEMINI_API_KEY 환경변수는 Cloudflare Pages → Settings → Environment Variables에 등록
export async function onRequestPost(context) {
  const { request, env } = context;
  const apiKey = env.GEMINI_API_KEY;

  if (!apiKey) {
    return Response.json(
      { error: 'GEMINI_API_KEY 환경변수가 설정되지 않았습니다. Cloudflare Pages → Settings → Environment Variables를 확인해주세요.' },
      { status: 500 }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: '잘못된 요청 형식입니다.' }, { status: 400 });
  }

  // 클라이언트가 model 을 지정하지 않은 경우의 기본값. main.js 의 GEMINI_MODEL 과 맞출 것.
  const model = body.model || 'gemini-3.6-flash';
  const contents = body.contents;

  if (!contents) {
    return Response.json({ error: 'contents 필드가 필요합니다.' }, { status: 400 });
  }

  const geminiBody = { contents };
  if (body.generationConfig) geminiBody.generationConfig = body.generationConfig;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 50000);

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody),
        signal: controller.signal
      }
    );

    clearTimeout(timeout);

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      return Response.json(
        { 
          error: data?.error?.message || `Gemini API 오류 (HTTP ${geminiRes.status})`,
          details: data?.error || data
        },
        { status: geminiRes.status }
      );
    }

    return Response.json(data);
  } catch(e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') {
      return Response.json(
        { error: '분석 시간이 초과됐습니다. 다시 시도해주세요.' },
        { status: 408 }
      );
    }
    return Response.json(
      { error: e.message },
      { status: 500 }
    );
  }
}
