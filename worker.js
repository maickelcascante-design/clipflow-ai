export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, platform: "cloudflare-workers" });
    }

    // TikTok OAuth: start
    if (url.pathname === "/auth/tiktok/start") {
      if (!env.TIKTOK_CLIENT_KEY) return new Response("Falta TIKTOK_CLIENT_KEY", {status:500});
      const state = crypto.randomUUID();
      const redirectUri = `${url.origin}/auth/tiktok/callback`;
      const params = new URLSearchParams({
        client_key: env.TIKTOK_CLIENT_KEY,
        response_type: "code",
        scope: "user.info.basic,video.publish",
        redirect_uri: redirectUri,
        state
      });
      return new Response(null, {
        status:302,
        headers:{
          Location:`https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`,
          "Set-Cookie":`cf_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
        }
      });
    }

    // TikTok OAuth: callback
    if (url.pathname === "/auth/tiktok/callback") {
      const code=url.searchParams.get("code");
      const state=url.searchParams.get("state");
      const cookies=request.headers.get("Cookie")||"";
      const expected=cookies.match(/(?:^|;\s*)cf_oauth_state=([^;]+)/)?.[1];

      if(!code || !state || !expected || state!==expected)
        return new Response("OAuth state inválido o expirado.",{status:400});

      const body=new URLSearchParams({
        client_key:env.TIKTOK_CLIENT_KEY,
        client_secret:env.TIKTOK_CLIENT_SECRET,
        code,
        grant_type:"authorization_code",
        redirect_uri:`${url.origin}/auth/tiktok/callback`
      });

      const response=await fetch("https://open.tiktokapis.com/v2/oauth/token/",{
        method:"POST",
        headers:{"Content-Type":"application/x-www-form-urlencoded"},
        body
      });
      const token=await response.json();

      if(token.error) return Response.json(token,{status:400});

      // TODO producción: guardar token/refresh_token en D1/KV cifrado
      return new Response(`<!doctype html>
<html><head><meta charset="utf-8"><title>TikTok conectado</title></head>
<body style="font-family:system-ui;background:#08090d;color:#fff;padding:40px">
<h1>✓ TikTok conectado</h1>
<p>La autorización se completó correctamente.</p>
<script>setTimeout(()=>window.close(),1200)</script>
</body></html>`,{headers:{"Content-Type":"text/html;charset=utf-8"}});
    }

    // OpenAI copy generation
    if (url.pathname==="/api/social/copy" && request.method==="POST") {
      const body=await request.json();
      if(!env.OPENAI_API_KEY) return Response.json({error:"Falta OPENAI_API_KEY"},{status:500});
      const r=await fetch("https://api.openai.com/v1/responses",{
        method:"POST",
        headers:{
          "Authorization":`Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type":"application/json"
        },
        body:JSON.stringify({
          model:env.TEXT_MODEL||"gpt-5.6",
          input:`Crea caption y hashtags para ${body.platform||"TikTok"}.
Tema: ${body.topic||""}. Tono: ${body.tone||"viral"}.
Devuelve SOLO JSON: {"caption":"...","hashtags":["#..."]}.`
        })
      });
      if(!r.ok) return new Response(await r.text(),{status:r.status});
      const data=await r.json();
      const text=(data.output||[])
        .flatMap(x=>x.content||[])
        .filter(x=>x.type==="output_text")
        .map(x=>x.text).join("");
      return Response.json(JSON.parse(text.replace(/^```json\s*|\s*```$/g,"").trim()));
    }

    return env.ASSETS.fetch(request);
  }
};
