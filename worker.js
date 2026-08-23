export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =========================================================
    // CORS
    // =========================================================
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
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

      if (!text || !text.trim()) {
        return {
          _empty: true,
          _raw: "",
        };
      }

      try {
        return JSON.parse(text);
      } catch {
        return {
          _invalidJson: true,
          _raw: text,
        };
      }
    }

    function getErrorMessage(data, fallback) {
      if (!data) return fallback;

      if (typeof data === "string" && data.trim()) {
        return data;
      }

      if (data.error?.message) {
        return data.error.message;
      }

      if (data.error?.code) {
        return data.error.code;
      }

      if (data.message) {
        return data.message;
      }

      if (data._raw) {
        return data._raw;
      }

      return fallback;
    }

    async function readRequestBody(request) {
      try {
        return await request.json();
      } catch {
        return null;
      }
    }

    // =========================================================
    // HEALTH
    // =========================================================

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        platform: "cloudflare-workers",
        ai: Boolean(env.OPENAI_API_KEY),
      });
    }

    // =========================================================
    // OPENAI VIDEO - CREAR JOB
    //
    // POST /api/jobs
    // =========================================================

    if (url.pathname === "/api/jobs" && request.method === "POST") {
      if (!env.OPENAI_API_KEY) {
        return json(
          {
            ok: false,
            error: "Falta OPENAI_API_KEY en las variables del Worker.",
          },
          500
        );
      }

      const body = await readRequestBody(request);

      if (!body) {
        return json(
          {
            ok: false,
            error: "El cuerpo de la solicitud no contiene JSON válido.",
          },
          400
        );
      }

      const topic = String(
        body.topic ||
        body.prompt ||
        body.guion ||
        "Crea un video corto atractivo."
      ).trim();

      const visualStyle = String(
        body.style ||
        body.visualStyle ||
        "Dinámico"
      ).trim();

      const voice = String(
        body.voice ||
        "Español"
      ).trim();

      /*
       * Sora 2 actualmente acepta 4, 8 o 12 segundos.
       * Tu interfaz muestra 30 segundos, así que convertimos:
       * 30+ -> 12 segundos.
       */
      let requestedSeconds = Number(
        body.duration ||
        body.seconds ||
        12
      );

      if (!Number.isFinite(requestedSeconds)) {
        requestedSeconds = 12;
      }

      let seconds = 12;

      if (requestedSeconds <= 4) {
        seconds = 4;
      } else if (requestedSeconds <= 8) {
        seconds = 8;
      } else {
        seconds = 12;
      }

      const prompt = `
Crea un video vertical corto para redes sociales.

Tema:
${topic}

Estilo visual:
${visualStyle}

Idioma de la narración:
${voice}

El video debe ser dinámico, atractivo y tener un gancho fuerte desde el principio.
Utiliza una composición vertical para redes sociales.
Mantén una narrativa clara y visualmente interesante.
`.trim();

      try {
        const openaiResponse = await fetch(
          "https://api.openai.com/v1/videos",
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: env.VIDEO_MODEL || "sora-2",
              prompt,
              seconds,
              size: "720x1280",
            }),
          }
        );

        const data = await safeJson(openaiResponse);

        if (!openaiResponse.ok) {
          return json(
            {
              ok: false,
              error: getErrorMessage(
                data,
                `OpenAI devolvió HTTP ${openaiResponse.status}.`
              ),
              status: openaiResponse.status,
              details: data,
            },
            openaiResponse.status
          );
        }

        if (data._empty || data._invalidJson) {
          return json(
            {
              ok: false,
              error:
                "OpenAI respondió sin JSON válido al crear el video.",
              status: openaiResponse.status,
              details: data._raw || null,
            },
            502
          );
        }

        if (!data.id) {
          return json(
            {
              ok: false,
              error: "OpenAI no devolvió un ID de video.",
              details: data,
            },
            502
          );
        }

        return json({
          ok: true,
          id: data.id,
          videoId: data.id,
          object: data.object || "video",
          status: data.status || "queued",
          progress: Number(data.progress || 0),
          seconds: data.seconds || seconds,
          size: data.size || "720x1280",
          model: data.model || env.VIDEO_MODEL || "sora-2",
        });
      } catch (error) {
        return json(
          {
            ok: false,
            error: `Error conectando con OpenAI: ${
              error?.message || String(error)
            }`,
          },
          502
        );
      }
    }

    // =========================================================
    // OPENAI VIDEO - CONSULTAR JOB
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
            ok: false,
            error: "Falta OPENAI_API_KEY en las variables del Worker.",
          },
          500
        );
      }

      const parts = url.pathname.split("/").filter(Boolean);

      // /api/jobs/:id/content
      const isContentRequest =
        parts.length === 4 && parts[3] === "content";

      // /api/jobs/:id
      const videoId = isContentRequest
        ? parts[2]
        : parts[2];

      if (!videoId || videoId === "content") {
        return json(
          {
            ok: false,
            error: "ID de video inválido.",
          },
          400
        );
      }

      // -------------------------------------------------------
      // Descargar contenido del video terminado
      // -------------------------------------------------------

      if (isContentRequest) {
        try {
          const contentResponse = await fetch(
            `https://api.openai.com/v1/videos/${encodeURIComponent(
              videoId
            )}/content`,
            {
              method: "GET",
              headers: {
                "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
              },
            }
          );

          if (!contentResponse.ok) {
            const errorData = await safeJson(contentResponse);

            return json(
              {
                ok: false,
                error: getErrorMessage(
                  errorData,
                  `No se pudo descargar el video. HTTP ${contentResponse.status}.`
                ),
                status: contentResponse.status,
                details: errorData,
              },
              contentResponse.status
            );
          }

          const headers = new Headers();
          headers.set(
            "Content-Type",
            contentResponse.headers.get("Content-Type") ||
              "video/mp4"
          );

          const contentLength =
            contentResponse.headers.get("Content-Length");

          if (contentLength) {
            headers.set("Content-Length", contentLength);
          }

          headers.set(
            "Content-Disposition",
            `inline; filename="clipflow-${videoId}.mp4"`
          );

          headers.set(
            "Cache-Control",
            "private, max-age=300"
          );

          Object.entries(corsHeaders).forEach(
            ([key, value]) => {
              headers.set(key, value);
            }
          );

          return new Response(contentResponse.body, {
            status: 200,
            headers,
          });
        } catch (error) {
          return json(
            {
              ok: false,
              error: `Error descargando el video: ${
                error?.message || String(error)
              }`,
            },
            502
          );
        }
      }

      // -------------------------------------------------------
      // Consultar estado
      // -------------------------------------------------------

      try {
        const openaiResponse = await fetch(
          `https://api.openai.com/v1/videos/${encodeURIComponent(
            videoId
          )}`,
          {
            method: "GET",
            headers: {
              "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
            },
          }
        );

        const data = await safeJson(openaiResponse);

        if (!openaiResponse.ok) {
          return json(
            {
              ok: false,
              error: getErrorMessage(
                data,
                `OpenAI devolvió HTTP ${openaiResponse.status}.`
              ),
              status: openaiResponse.status,
              details: data,
            },
            openaiResponse.status
          );
        }

        if (data._empty || data._invalidJson) {
          return json(
            {
              ok: false,
              error:
                "OpenAI respondió sin JSON válido al consultar el video.",
              details: data._raw || null,
            },
            502
          );
        }

        const response = {
          ok: true,
          id: data.id || videoId,
          videoId: data.id || videoId,
          status: data.status || "unknown",
          progress: Number(data.progress || 0),
          seconds: data.seconds || null,
          size: data.size || "720x1280",
          model: data.model || "sora-2",
          created_at: data.created_at || null,
          completed_at: data.completed_at || null,
        };

        if (data.status === "completed") {
          response.videoUrl =
            `${url.origin}/api/jobs/${encodeURIComponent(
              videoId
            )}/content`;
        }

        if (data.status === "failed") {
          response.error =
            data.error?.message ||
            data.error?.code ||
            "La generación del video falló.";
        }

        return json(response);
      } catch (error) {
        return json(
          {
            ok: false,
            error: `Error consultando OpenAI: ${
              error?.message || String(error)
            }`,
          },
          502
        );
      }
    }

    // =========================================================
    // OPENAI COPY / CAPTION
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
            ok: false,
            error: "Falta OPENAI_API_KEY.",
          },
          500
        );
      }

      const body = await readRequestBody(request);

      if (!body) {
        return json(
          {
            ok: false,
            error: "JSON inválido.",
          },
          400
        );
      }

      const platform = body.platform || "TikTok";
      const topic = body.topic || "";
      const tone = body.tone || "viral";

      try {
        const response = await fetch(
          "https://api.openai.com/v1/responses",
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: env.TEXT_MODEL || "gpt-5.6",
              input: `
Crea un caption y hashtags para ${platform}.

Tema:
${topic}

Tono:
${tone}

Devuelve únicamente JSON válido con esta estructura:
{
  "caption": "...",
  "hashtags": ["#...", "#...", "#..."]
}
              `.trim(),
            }),
          }
        );

        const data = await safeJson(response);

        if (!response.ok) {
          return json(
            {
              ok: false,
              error: getErrorMessage(
                data,
                `OpenAI devolvió HTTP ${response.status}.`
              ),
              details: data,
            },
            response.status
          );
        }

        if (data._empty || data._invalidJson) {
          return json(
            {
              ok: false,
              error: "OpenAI no devolvió JSON válido.",
              details: data._raw || null,
            },
            502
          );
        }

        let text = "";

        if (data.output_text) {
          text = data.output_text;
        } else {
          text = (data.output || [])
            .flatMap((item) => item.content || [])
            .filter((item) => item.type === "output_text")
            .map((item) => item.text || "")
            .join("");
        }

        text = text
          .replace(/^```json\s*/i, "")
          .replace(/\s*```$/i, "")
          .trim();

        if (!text) {
          return json(
            {
              ok: false,
              error: "OpenAI no devolvió contenido de texto.",
            },
            502
          );
        }

        let result;

        try {
          result = JSON.parse(text);
        } catch {
          return json(
            {
              ok: false,
              error:
                "La respuesta de OpenAI no pudo convertirse en JSON.",
              raw: text,
            },
            502
          );
        }

        return json({
          ok: true,
          ...result,
        });
      } catch (error) {
        return json(
          {
            ok: false,
            error: `Error generando copy: ${
              error?.message || String(error)
            }`,
          },
          502
        );
      }
    }

    // =========================================================
    // TIKTOK OAUTH - START
    // =========================================================

    if (url.pathname === "/auth/tiktok/start") {
      if (!env.TIKTOK_CLIENT_KEY) {
        return new Response(
          "Falta TIKTOK_CLIENT_KEY",
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
        state,
      });

      return new Response(null, {
        status: 302,
        headers: {
          Location:
            `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`,

          "Set-Cookie":
            `cf_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        },
      });
    }

    // =========================================================
    // TIKTOK OAUTH - CALLBACK
    // =========================================================

    if (url.pathname === "/auth/tiktok/callback") {
      if (
        !env.TIKTOK_CLIENT_KEY ||
        !env.TIKTOK_CLIENT_SECRET
      ) {
        return new Response(
          "Faltan las variables de TikTok.",
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
          `${url.origin}/auth/tiktok/callback`,
      });

      try {
        const response = await fetch(
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

        const token = await safeJson(response);

        if (!response.ok || token.error) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: getErrorMessage(
                token,
                "Error de autorización de TikTok."
              ),
            }),
            {
              status: 400,
              headers: {
                "Content-Type":
                  "application/json; charset=utf-8",
              },
            }
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
                "text/html;charset=utf-8",
            },
          }
        );
      } catch (error) {
        return new Response(
          `Error conectando TikTok: ${
            error?.message || String(error)
          }`,
          { status: 502 }
        );
      }
    }

    // =========================================================
    // ASSETS / FRONTEND
    // =========================================================

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return json(
      {
        ok: false,
        error: "No se encontró ASSETS en el Worker.",
      },
      500
    );
  },
};
