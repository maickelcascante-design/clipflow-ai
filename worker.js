export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =========================================================
    // Helpers
    // =========================================================

    const json = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store"
        }
      });
    };

    const getErrorText = async (response) => {
      const text = await response.text();

      if (!text) {
        return `OpenAI respondió sin contenido (HTTP ${response.status}).`;
      }

      try {
        const parsed = JSON.parse(text);

        return (
          parsed?.error?.message ||
          parsed?.message ||
          parsed?.error ||
          text
        );
      } catch {
        return text;
      }
    };

    const openAIHeaders = {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    };

    // =========================================================
    // HEALTH
    // =========================================================

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        platform: "cloudflare-workers"
      });
    }

    // =========================================================
    // TIKTOK OAUTH - START
    // =========================================================

    if (url.pathname === "/auth/tiktok/start") {
      if (!env.TIKTOK_CLIENT_KEY) {
        return new Response(
          "Falta configurar TIKTOK_CLIENT_KEY en Cloudflare.",
          { status: 500 }
        );
      }

      const state = crypto.randomUUID();

      const redirectUri =
        `${url.origin}/auth/tiktok/callback`;

      const params = new URLSearchParams({
        client_key: env.TIKTOK_CLIENT_KEY,
        response_type: "code",
        scope: "user.info.basic,video.publish",
        redirect_uri: redirectUri,
        state
      });

      return new Response(null, {
        status: 302,
        headers: {
          Location:
            `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`,

          "Set-Cookie":
            `cf_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
        }
      });
    }

    // =========================================================
    // TIKTOK OAUTH - CALLBACK
    // =========================================================

    if (url.pathname === "/auth/tiktok/callback") {
      if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) {
        return new Response(
          "Faltan TIKTOK_CLIENT_KEY o TIKTOK_CLIENT_SECRET.",
          { status: 500 }
        );
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      const cookies =
        request.headers.get("Cookie") || "";

      const expected =
        cookies.match(
          /(?:^|;\s*)cf_oauth_state=([^;]+)/
        )?.[1];

      if (
        !code ||
        !state ||
        !expected ||
        state !== expected
      ) {
        return new Response(
          "OAuth state inválido o expirado.",
          { status: 400 }
        );
      }

      const body = new URLSearchParams({
        client_key: env.TIKTOK_CLIENT_KEY,
        client_secret: env.TIKTOK_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri:
          `${url.origin}/auth/tiktok/callback`
      });

      const response = await fetch(
        "https://open.tiktokapis.com/v2/oauth/token/",
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded"
          },
          body
        }
      );

      const responseText = await response.text();

      let token;

      try {
        token = responseText
          ? JSON.parse(responseText)
          : null;
      } catch {
        return new Response(
          `TikTok devolvió una respuesta no válida: ${responseText || "vacía"}`,
          { status: 502 }
        );
      }

      if (!response.ok || token?.error) {
        return json(
          {
            ok: false,
            provider: "tiktok",
            error:
              token?.error_description ||
              token?.error ||
              "Error de autorización de TikTok."
          },
          400
        );
      }

      return new Response(
        `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>TikTok conectado</title>
</head>

<body style="font-family:system-ui;background:#08090d;color:#fff;padding:40px">

<h1>✓ TikTok conectado</h1>

<p>La autorización se completó correctamente.</p>

<script>
setTimeout(() => window.close(), 1200);
</script>

</body>
</html>`,
        {
          headers: {
            "Content-Type":
              "text/html;charset=utf-8"
          }
        }
      );
    }

    // =========================================================
    // OPENAI - GENERAR COPY SOCIAL
    // =========================================================

    if (
      url.pathname === "/api/social/copy" &&
      request.method === "POST"
    ) {
      if (!env.OPENAI_API_KEY) {
        return json(
          {
            error:
              "Falta configurar OPENAI_API_KEY en Cloudflare."
          },
          500
        );
      }

      let body;

      try {
        body = await request.json();
      } catch {
        return json(
          {
            error: "El cuerpo enviado no es JSON válido."
          },
          400
        );
      }

      const platform =
        body?.platform || "TikTok";

      const topic =
        body?.topic || "";

      const tone =
        body?.tone || "viral";

      const prompt = `
Crea un caption y hashtags para ${platform}.

Tema:
${topic}

Tono:
${tone}

Devuelve ÚNICAMENTE JSON válido con esta estructura:

{
  "caption": "...",
  "hashtags": ["#...", "#...", "#..."]
}
`;

      const response = await fetch(
        "https://api.openai.com/v1/responses",
        {
          method: "POST",
          headers: openAIHeaders,
          body: JSON.stringify({
            model:
              env.TEXT_MODEL || "gpt-5.6",
            input: prompt
          })
        }
      );

      if (!response.ok) {
        const error =
          await getErrorText(response);

        return json(
          {
            ok: false,
            error
          },
          response.status
        );
      }

      const data = await response.json();

      let text = "";

      if (data?.output_text) {
        text = data.output_text;
      } else {
        text = (data?.output || [])
          .flatMap(
            item => item?.content || []
          )
          .filter(
            item =>
              item?.type === "output_text"
          )
          .map(
            item => item?.text || ""
          )
          .join("");
      }

      text = text
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      if (!text) {
        return json(
          {
            ok: false,
            error:
              "OpenAI no devolvió texto para generar el copy.",
            raw: data
          },
          502
        );
      }

      try {
        return json(JSON.parse(text));
      } catch {
        return json(
          {
            ok: false,
            error:
              "OpenAI devolvió contenido que no es JSON válido.",
            raw: text
          },
          502
        );
      }
    }

    // =========================================================
    // OPENAI SORA - CREAR VIDEO
    // POST /api/jobs
    // =========================================================

    if (
      url.pathname === "/api/jobs" &&
      request.method === "POST"
    ) {
      if (!env.OPENAI_API_KEY) {
        return json(
          {
            ok: false,
            error:
              "Falta configurar OPENAI_API_KEY en Cloudflare."
          },
          500
        );
      }

      let body;

      try {
        body = await request.json();
      } catch {
        return json(
          {
            ok: false,
            error:
              "El cuerpo enviado no es JSON válido."
          },
          400
        );
      }

      const topic =
        body?.topic ||
        body?.prompt ||
        "Crea un video corto atractivo.";

      const style =
        body?.style ||
        body?.visualStyle ||
        "Dinámico";

      const duration =
        Number(body?.duration) || 4;

      // Sora admite actualmente 4, 8 o 12 segundos.
      const allowedSeconds = [4, 8, 12];

      const seconds =
        allowedSeconds.includes(duration)
          ? duration
          : 4;

      const prompt = `
Crea un video vertical para redes sociales.

Tema:
${topic}

Estilo visual:
${style}

El video debe ser:
- dinámico
- atractivo
- moderno
- con un gancho visual fuerte al principio
- formato vertical 9:16
- pensado para un Short/Reel/TikTok
- sin texto ilegible en pantalla
`;

      const response = await fetch(
        "https://api.openai.com/v1/videos",
        {
          method: "POST",

          headers: {
            ...openAIHeaders
          },

          body: JSON.stringify({
            model:
              env.VIDEO_MODEL || "sora-2",

            prompt,

            seconds,

            size:
              env.VIDEO_SIZE || "720x1280"
          })
        }
      );

      if (!response.ok) {
        const error =
          await getErrorText(response);

        return json(
          {
            ok: false,
            error,
            status: response.status
          },
          response.status
        );
      }

      let data;

      try {
        data = await response.json();
      } catch {
        return json(
          {
            ok: false,
            error:
              "OpenAI creó una respuesta que no pudo interpretarse como JSON."
          },
          502
        );
      }

      if (!data?.id) {
        return json(
          {
            ok: false,
            error:
              "OpenAI no devolvió un ID de video.",
            data
          },
          502
        );
      }

      return json({
        ok: true,

        id: data.id,

        status:
          data.status || "queued",

        progress:
          data.progress || 0,

        model:
          data.model || env.VIDEO_MODEL || "sora-2",

        seconds:
          data.seconds || seconds,

        size:
          data.size ||
          env.VIDEO_SIZE ||
          "720x1280"
      });
    }

    // =========================================================
    // OPENAI SORA - CONSULTAR VIDEO
    // GET /api/jobs/{id}
    // =========================================================

    if (
      url.pathname.startsWith("/api/jobs/") &&
      request.method === "GET"
    ) {
      if (!env.OPENAI_API_KEY) {
        return json(
          {
            ok: false,
            error:
              "Falta configurar OPENAI_API_KEY en Cloudflare."
          },
          500
        );
      }

      const id =
        url.pathname
          .split("/")
          .filter(Boolean)
          .pop();

      if (!id || id === "jobs") {
        return json(
          {
            ok: false,
            error:
              "ID de video inválido."
          },
          400
        );
      }

      const response = await fetch(
        `https://api.openai.com/v1/videos/${encodeURIComponent(id)}`,
        {
          method: "GET",
          headers: {
            "Authorization":
              `Bearer ${env.OPENAI_API_KEY}`
          }
        }
      );

      if (!response.ok) {
        const error =
          await getErrorText(response);

        return json(
          {
            ok: false,
            error,
            status: response.status
          },
          response.status
        );
      }

      let data;

      try {
        data = await response.json();
      } catch {
        return json(
          {
            ok: false,
            error:
              "OpenAI devolvió una respuesta no válida."
          },
          502
        );
      }

      return json({
        ok: true,

        id: data.id,

        status:
          data.status,

        progress:
          data.progress || 0,

        model:
          data.model,

        seconds:
          data.seconds,

        size:
          data.size,

        error:
          data.error || null,

        completed_at:
          data.completed_at || null,

        // El frontend puede usar este endpoint
        // cuando el video esté completado.
        content_url:
          data.status === "completed"
            ? `${url.origin}/api/jobs/${encodeURIComponent(id)}/content`
            : null
      });
    }

    // =========================================================
    // OPENAI SORA - CONTENIDO DEL VIDEO
    // GET /api/jobs/{id}/content
    // =========================================================

    if (
      url.pathname.startsWith("/api/jobs/") &&
      url.pathname.endsWith("/content") &&
      request.method === "GET"
    ) {
      if (!env.OPENAI_API_KEY) {
        return new Response(
          "Falta configurar OPENAI_API_KEY en Cloudflare.",
          { status: 500 }
        );
      }

      const parts =
        url.pathname
          .split("/")
          .filter(Boolean);

      const id =
        parts[2];

      if (!id) {
        return new Response(
          "ID de video inválido.",
          { status: 400 }
        );
      }

      const response = await fetch(
        `https://api.openai.com/v1/videos/${encodeURIComponent(id)}/content`,
        {
          method: "GET",
          headers: {
            "Authorization":
              `Bearer ${env.OPENAI_API_KEY}`
          }
        }
      );

      if (!response.ok) {
        const error =
          await getErrorText(response);

        return json(
          {
            ok: false,
            error
          },
          response.status
        );
      }

      const headers =
        new Headers(response.headers);

      headers.set(
        "Content-Type",
        "video/mp4"
      );

      headers.set(
        "Cache-Control",
        "no-store"
      );

      return new Response(
        response.body,
        {
          status: response.status,
          headers
        }
      );
    }

    // =========================================================
    // FALLBACK - ARCHIVOS ESTÁTICOS
    // =========================================================

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response(
      "ClipFlow AI Worker funcionando.",
      {
        status: 200,
        headers: {
          "Content-Type":
            "text/plain; charset=utf-8"
        }
      }
    );
  }
};
