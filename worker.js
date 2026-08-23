const OPENAI_API = "https://api.openai.com/v1";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // =========================================================
    // CORS
    // =========================================================

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // =========================================================
    // HELPERS
    // =========================================================

    function json(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ...corsHeaders,
        },
      });
    }

    async function safeJson(response) {
      const text = await response.text();

      if (!text) {
        return {
          data: {},
          raw: "",
        };
      }

      try {
        return {
          data: JSON.parse(text),
          raw: text,
        };
      } catch {
        return {
          data: {},
          raw: text,
        };
      }
    }

    function openAIError(response, data, raw) {
      return json(
        {
          error:
            data?.error?.message ||
            data?.error ||
            raw ||
            `OpenAI respondió con HTTP ${response.status}`,
          openai_status: response.status,
          openai_response: data || raw || null,
        },
        response.status
      );
    }

    async function getBody(request) {
      try {
        return await request.json();
      } catch {
        return {};
      }
    }

    function getDuration(value) {
      const n = Number(value);

      // La API de Sora 2 acepta 4, 8 o 12 segundos.
      if (n <= 4) return "4";
      if (n <= 8) return "8";
      return "12";
    }

    // =========================================================
    // HEALTH CHECK
    // =========================================================

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({
        ok: true,
        platform: "cloudflare-workers",
        service: "clipflow-ai",
        openai_configured: Boolean(env.OPENAI_API_KEY),
        time: new Date().toISOString(),
      });
    }

    // =========================================================
    // CREATE VIDEO JOB
    // POST /api/jobs
    // =========================================================

    if (url.pathname === "/api/jobs" && request.method === "POST") {
      if (!env.OPENAI_API_KEY) {
        return json(
          {
            error: "Falta configurar OPENAI_API_KEY en Cloudflare.",
          },
          500
        );
      }

      const body = await getBody(request);

      const topic =
        body.topic ||
        body.prompt ||
        body.description ||
        "Crea un video corto atractivo";

      const visualStyle =
        body.visualStyle ||
        body.style ||
        "Dinámico";

      const format =
        body.format ||
        "9:16";

      const requestedDuration = Number(body.duration || 30);

      const seconds = getDuration(requestedDuration);

      // ---------------------------------------------------------
      // Prompt final para Sora
      // ---------------------------------------------------------

      const prompt = `
Crea un video vertical para redes sociales.

Tema:
${topic}

Estilo visual:
${visualStyle}

Formato:
${format}

Características:
- Video vertical 9:16.
- Ritmo dinámico.
- Imágenes visualmente atractivas.
- Gancho fuerte desde el principio.
- Escenas con movimiento.
- Estética moderna y profesional.
- Pensado para YouTube Shorts, TikTok e Instagram Reels.
- No agregues texto ilegible.
- Mantén una composición clara y atractiva.

Duración solicitada por el usuario:
${requestedDuration} segundos.

Duración disponible en el modelo:
${seconds} segundos.
`.trim();

      // ---------------------------------------------------------
      // IMPORTANTE:
      // Videos API utiliza multipart/form-data.
      // ---------------------------------------------------------

      const form = new FormData();

      form.append("model", "sora-2");
      form.append("prompt", prompt);
      form.append("seconds", seconds);
      form.append("size", "720x1280");

      let response;

      try {
        response = await fetch(`${OPENAI_API}/videos`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          },
          body: form,
        });
      } catch (error) {
        return json(
          {
            error: "No se pudo conectar con OpenAI.",
            details: String(error?.message || error),
          },
          502
        );
      }

      const { data, raw } = await safeJson(response);

      if (!response.ok) {
        return openAIError(response, data, raw);
      }

      // ---------------------------------------------------------
      // Respuesta al frontend
      // ---------------------------------------------------------

      return json({
        ok: true,

        id: data.id || null,

        object: data.object || "video",

        status: data.status || "queued",

        progress: data.progress ?? 0,

        model: data.model || "sora-2",

        requested_duration: requestedDuration,

        actual_duration: Number(seconds),

        size: data.size || "720x1280",

        prompt,

        created_at: data.created_at || null,

        completed_at: data.completed_at || null,

        error: data.error || null,

        // URL que tu frontend puede utilizar para consultar el trabajo.
        job_url: data.id
          ? `${url.origin}/api/jobs/${data.id}`
          : null,

        // Cuando esté terminado, este endpoint servirá el MP4.
        content_url: data.id
          ? `${url.origin}/api/jobs/${data.id}/content`
          : null,

        openai: data,
      });
    }

    // =========================================================
    // GET VIDEO JOB STATUS
    //
    // GET /api/jobs/:id
    // =========================================================

    if (
      url.pathname.startsWith("/api/jobs/") &&
      request.method === "GET"
    ) {
      if (!env.OPENAI_API_KEY) {
        return json(
          {
            error: "Falta configurar OPENAI_API_KEY en Cloudflare.",
          },
          500
        );
      }

      const parts = url.pathname.split("/").filter(Boolean);

      // /api/jobs/:id
      const id = parts[2];

      if (!id) {
        return json(
          {
            error: "ID de video inválido.",
          },
          400
        );
      }

      // Si pidieron /content, lo manejamos abajo.
      if (parts[3] === "content") {
        return await proxyVideoContent(id, env, corsHeaders);
      }

      let response;

      try {
        response = await fetch(`${OPENAI_API}/videos/${id}`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          },
        });
      } catch (error) {
        return json(
          {
            error: "No se pudo consultar el video en OpenAI.",
            details: String(error?.message || error),
          },
          502
        );
      }

      const { data, raw } = await safeJson(response);

      if (!response.ok) {
        return openAIError(response, data, raw);
      }

      const status = data.status || "unknown";

      return json({
        ok: true,

        id: data.id || id,

        object: data.object || "video",

        status,

        progress: data.progress ?? 0,

        model: data.model || "sora-2",

        size: data.size || "720x1280",

        seconds: data.seconds || null,

        created_at: data.created_at || null,

        completed_at: data.completed_at || null,

        expires_at: data.expires_at || null,

        error: data.error || null,

        // El frontend puede usar esta URL cuando status === completed.
        content_url:
          status === "completed"
            ? `${url.origin}/api/jobs/${id}/content`
            : null,

        openai: data,
      });
    }

    // =========================================================
    // DOWNLOAD / STREAM VIDEO
    //
    // GET /api/jobs/:id/content
    // =========================================================

    async function proxyVideoContent(id, env, cors) {
      if (!env.OPENAI_API_KEY) {
        return json(
          {
            error: "Falta configurar OPENAI_API_KEY en Cloudflare.",
          },
          500
        );
      }

      let response;

      try {
        response = await fetch(
          `${OPENAI_API}/videos/${id}/content`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            },
          }
        );
      } catch (error) {
        return json(
          {
            error: "No se pudo descargar el video.",
            details: String(error?.message || error),
          },
          502
        );
      }

      if (!response.ok) {
        const { data, raw } = await safeJson(response);

        return openAIError(response, data, raw);
      }

      const headers = new Headers();

      const contentType =
        response.headers.get("Content-Type") ||
        "video/mp4";

      headers.set("Content-Type", contentType);

      const contentLength =
        response.headers.get("Content-Length");

      if (contentLength) {
        headers.set("Content-Length", contentLength);
      }

      headers.set(
        "Content-Disposition",
        `inline; filename="clipflow-${id}.mp4"`
      );

      headers.set(
        "Cache-Control",
        "private, max-age=300"
      );

      for (const [key, value] of Object.entries(cors)) {
        headers.set(key, value);
      }

      return new Response(response.body, {
        status: response.status,
        headers,
      });
    }

    // =========================================================
    // OPENAI SOCIAL COPY
    //
    // POST /api/social/copy
    // =========================================================

    if (
      url.pathname === "/api/social/copy" &&
      request.method === "POST"
    ) {
      if (!env.OPENAI_API_KEY) {
        return json(
          {
            error: "Falta configurar OPENAI_API_KEY en Cloudflare.",
          },
          500
        );
      }

      const body = await getBody(request);

      const platform = body.platform || "TikTok";
      const topic = body.topic || "";
      const tone = body.tone || "viral";

      const prompt = `
Crea contenido para redes sociales.

Plataforma:
${platform}

Tema:
${topic}

Tono:
${tone}

Devuelve SOLO JSON válido con esta estructura:

{
  "caption": "texto de la publicación",
  "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3", "#hashtag4", "#hashtag5"]
}

No uses Markdown.
No agregues explicaciones.
`.trim();

      let response;

      try {
        response = await fetch(`${OPENAI_API}/responses`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: env.TEXT_MODEL || "gpt-5.6",
            input: prompt,
          }),
        });
      } catch (error) {
        return json(
          {
            error: "No se pudo conectar con OpenAI.",
            details: String(error?.message || error),
          },
          502
        );
      }

      const { data, raw } = await safeJson(response);

      if (!response.ok) {
        return openAIError(response, data, raw);
      }

      // Responses API normalmente devuelve output.
      let text = "";

      if (typeof data.output_text === "string") {
        text = data.output_text;
      }

      if (!text && Array.isArray(data.output)) {
        for (const item of data.output) {
          if (!Array.isArray(item.content)) continue;

          for (const content of item.content) {
            if (typeof content.text === "string") {
              text += content.text;
            }
          }
        }
      }

      text = text
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      let result;

      try {
        result = JSON.parse(text);
      } catch {
        return json(
          {
            error: "OpenAI devolvió contenido que no es JSON válido.",
            raw: text,
          },
          502
        );
      }

      return json({
        ok: true,
        caption: result.caption || "",
        hashtags: Array.isArray(result.hashtags)
          ? result.hashtags
          : [],
      });
    }

    // =========================================================
    // TIKTOK OAUTH - START
    //
    // GET /auth/tiktok/start
    // =========================================================

    if (
      url.pathname === "/auth/tiktok/start" &&
      request.method === "GET"
    ) {
      if (!env.TIKTOK_CLIENT_KEY) {
        return new Response(
          "Falta TIKTOK_CLIENT_KEY",
          {
            status: 500,
            headers: corsHeaders,
          }
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
        state,
      });

      return new Response(null, {
        status: 302,
        headers: {
          Location:
            `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`,

          "Set-Cookie":
            `cf_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,

          ...corsHeaders,
        },
      });
    }

    // =========================================================
    // TIKTOK OAUTH - CALLBACK
    //
    // GET /auth/tiktok/callback
    // =========================================================

    if (
      url.pathname === "/auth/tiktok/callback" &&
      request.method === "GET"
    ) {
      if (
        !env.TIKTOK_CLIENT_KEY ||
        !env.TIKTOK_CLIENT_SECRET
      ) {
        return new Response(
          "Faltan las variables de TikTok.",
          {
            status: 500,
            headers: corsHeaders,
          }
        );
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      const cookie =
        request.headers.get("Cookie") || "";

      const match = cookie.match(
        /(?:^|;\s*)cf_oauth_state=([^;]+)/
      );

      const expectedState =
        match?.[1] || "";

      if (
        !code ||
        !state ||
        !expectedState ||
        state !== expectedState
      ) {
        return new Response(
          "OAuth state inválido o expirado.",
          {
            status: 400,
            headers: corsHeaders,
          }
        );
      }

      const body = new URLSearchParams({
        client_key: env.TIKTOK_CLIENT_KEY,
        client_secret: env.TIKTOK_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri:
          `${url.origin}/auth/tiktok/callback`,
      });

      let response;

      try {
        response = await fetch(
          "https://open.tiktokapis.com/v2/oauth/token/",
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/x-www-form-urlencoded",
            },
            body,
          }
        );
      } catch (error) {
        return new Response(
          `Error conectando con TikTok: ${String(
            error?.message || error
          )}`,
          {
            status: 502,
            headers: corsHeaders,
          }
        );
      }

      const { data, raw } =
        await safeJson(response);

      if (!response.ok) {
        return openAIError(response, data, raw);
      }

      if (data.error) {
        return json(
          {
            error: data.error,
            error_description:
              data.error_description || null,
          },
          400
        );
      }

      // ---------------------------------------------------------
      // IMPORTANTE:
      // No guardamos tokens permanentemente aquí.
      // Para producción debes usar KV/D1/DO u otro almacenamiento.
      // ---------------------------------------------------------

      return new Response(
        `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>TikTok conectado</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="font-family:system-ui;background:#08090d;color:white;padding:40px">
<h1>✓ TikTok conectado</h1>
<p>La autorización se completó correctamente.</p>
<p>Puedes cerrar esta ventana.</p>
</body>
</html>`,
        {
          status: 200,
          headers: {
            "Content-Type":
              "text/html; charset=utf-8",
            ...corsHeaders,
          },
        }
      );
    }

    // =========================================================
    // ROOT
    // =========================================================

    if (
      url.pathname === "/" ||
      url.pathname === ""
    ) {
      return json({
        ok: true,
        service: "ClipFlow AI",
        message: "Worker funcionando correctamente.",
        endpoints: {
          health: "GET /api/health",
          create_video: "POST /api/jobs",
          video_status: "GET /api/jobs/:id",
          video_content:
            "GET /api/jobs/:id/content",
          social_copy:
            "POST /api/social/copy",
          tiktok:
            "GET /auth/tiktok/start",
        },
      });
    }

    // =========================================================
    // FALLBACK
    // =========================================================

    return json(
      {
        error: "Ruta no encontrada.",
        path: url.pathname,
        method: request.method,
      },
      404
    );
  },
};
