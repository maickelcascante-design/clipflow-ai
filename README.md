# ClipFlow Pro — plataforma de Shorts automatizados

Incluye:
- Guion IA y división automática en escenas.
- Video vertical generado con Sora.
- Narración TTS.
- Montaje FFmpeg.
- Subtítulos SRT quemados en el video.
- Biblioteca de música local (`generated/music/`).
- Historial persistente de proyectos.
- Generación de caption + hashtags con IA.
- Adaptador de publicación directa a TikTok.
- Webhook para workers/automatizaciones.
- Preparado para integrar OAuth de YouTube e Instagram.

## Requisitos
Node.js 20+, FFmpeg y una API key de OpenAI.

## Instalación
```bash
npm install
cp .env.example .env
npm start
```

## Música
Copia tus pistas autorizadas a:
`generated/music/`

## TikTok
La API de TikTok requiere una app registrada, OAuth del usuario y scopes aprobados. El endpoint:
`POST /api/social/tiktok`
acepta `videoUrl`, `title`, `accessToken` y `privacy`.

Para publicación directa, TikTok exige autorización `video.publish`; clientes no auditados tienen restricciones de visibilidad. Para subir como borrador se usa `video.upload`.

## Producción
Para una plataforma multiusuario:
- PostgreSQL/Redis para jobs.
- S3/R2 para videos.
- Worker separado para FFmpeg.
- OAuth cifrado por usuario.
- Rate limits y colas.
- Moderación antes de publicar.
