# ClipFlow en Cloudflare Workers

## 1. Instalar y autenticar
```bash
npm install
npx wrangler login
```

## 2. Deploy
```bash
npx wrangler deploy
```

Cloudflare mostrará una URL:
`https://clipflow-ai.<subdominio>.workers.dev`

## 3. Secretos
```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put TIKTOK_CLIENT_KEY
npx wrangler secret put TIKTOK_CLIENT_SECRET
```

## 4. TikTok
En la configuración de tu aplicación TikTok registra exactamente:

`https://TU-SUBDOMINIO.workers.dev/auth/tiktok/callback`

El botón Conectar TikTok usa:

`https://TU-SUBDOMINIO.workers.dev/auth/tiktok/start`

## 5. Producción
Cloudflare Worker maneja frontend/API/OAuth. Para generación de videos larga se recomienda:
- D1: usuarios/proyectos
- R2: MP4/audio
- Queues: trabajos
- Worker/servicio de render dedicado: FFmpeg
