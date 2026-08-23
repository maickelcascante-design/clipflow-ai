import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const exec = promisify(execFile);

app.use(cors());
app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(process.cwd(), "public")));
app.use("/generated", express.static(path.join(process.cwd(), "generated")));

const ROOT = path.join(process.cwd(), "generated");
fs.mkdirSync(ROOT, {recursive:true});
const jobs = new Map();
const DB_FILE = path.join(process.cwd(), "generated", "jobs.json");
function loadJobs(){
  try{
    const raw=JSON.parse(fs.readFileSync(DB_FILE,"utf8"));
    for(const [id,j] of Object.entries(raw)) jobs.set(id,j);
  }catch{}
}
function saveJobs(){
  const serial={};
  for(const [id,j] of jobs) serial[id]={...j,dir:undefined};
  fs.writeFileSync(DB_FILE,JSON.stringify(serial,null,2));
}
loadJobs();

const sleep = ms => new Promise(r=>setTimeout(r,ms));

app.get("/api/health", (_req,res)=>res.json({ok:true, ffmpeg:!!process.env.FFMPEG_PATH}));

app.post("/api/script", async (req,res)=>{
  try {
    const { topic, duration=30, style="Dinámico", language="es" } = req.body;
    if(!topic?.trim()) return res.status(400).json({error:"Falta topic"});
    const scenes = Math.max(3, Math.min(8, Math.ceil(Number(duration)/8)));
    const response = await openai.responses.create({
      model: process.env.TEXT_MODEL || "gpt-5.6",
      input: `Crea un short vertical de ${duration} segundos en ${language}.
Tema: ${topic}
Estilo: ${style}
Divide el video en exactamente ${scenes} escenas. Cada escena debe durar 8 segundos o menos.
Devuelve SOLO JSON con: title, hook, cta, scenes:[{narration, visual_prompt, seconds}].
La suma de seconds debe ser cercana a ${duration}. visual_prompt debe describir una toma vertical cinematográfica, sin texto incrustado.`
    });
    const text=response.output_text.replace(/^```json\s*|\s*```$/g,"").trim();
    const data=JSON.parse(text);
    res.json(data);
  } catch(e){ console.error(e); res.status(500).json({error:e.message}); }
});

async function createSoraClip(prompt, seconds, jobDir, index){
  const video = await openai.videos.create({
    model: process.env.VIDEO_MODEL || "sora-2",
    prompt,
    seconds: String(Math.min(8, Math.max(4, Number(seconds)||8))),
    size: "720x1280"
  });
  let v=video;
  while(v.status!=="completed"){
    if(v.status==="failed") throw new Error(`Sora falló en escena ${index+1}`);
    await sleep(3000);
    v=await openai.videos.retrieve(video.id);
  }
  const content = await openai.videos.downloadContent(v.id);
  const buf=Buffer.from(await content.arrayBuffer());
  const out=path.join(jobDir,`scene-${index}.mp4`);
  fs.writeFileSync(out,buf);
  return out;
}

async function createVoice(text, jobDir, index){
  const speech=await openai.audio.speech.create({
    model:process.env.TTS_MODEL || "gpt-4o-mini-tts",
    voice:process.env.TTS_VOICE || "marin",
    input:text,
    response_format:"mp3"
  });
  const out=path.join(jobDir,`voice-${index}.mp3`);
  fs.writeFileSync(out,Buffer.from(await speech.arrayBuffer()));
  return out;
}

async function assemble(job, scenes){
  const dir=job.dir;
  const concat=path.join(dir,"concat.txt");
  fs.writeFileSync(concat, scenes.map(s=>`file '${s.video.replaceAll("'","'\\''")}'`).join("\n"));
  const silent=path.join(dir,"silent.mp4");
  const final=path.join(dir,"clipflow-final.mp4");

  await exec(process.env.FFMPEG_PATH||"ffmpeg",[
    "-y","-f","concat","-safe","0","-i",concat,"-c","copy",silent
  ]);

  // Narration is mixed as a single audio track. Individual voice files are concatenated first.
  const voices=job.voices;
  const vconcat=path.join(dir,"voices.txt");
  fs.writeFileSync(vconcat, voices.map(v=>`file '${v.replaceAll("'","'\\''")}'`).join("\n"));
  const audio=path.join(dir,"voice-track.mp3");
  await exec(process.env.FFMPEG_PATH||"ffmpeg",["-y","-f","concat","-safe","0","-i",vconcat,"-c","copy",audio]);

  // Burn a clean subtitle track from the narration strings.
  let t=0, ass=[];
  const esc=s=>s.replace(/[{}]/g,"");
  for(const sc of scenes){
    const sec=Number(sc.seconds)||8;
    const start=t, end=t+sec; t=end;
    const fmt=x=>{let h=Math.floor(x/3600),m=Math.floor((x%3600)/60),s=x%60;return `${h}:${String(m).padStart(2,"0")}:${String(s.toFixed(2)).padStart(5,"0")}`};
    ass.push(`${fmt(start)} --> ${fmt(end)}\n${esc(sc.narration)}\n`);
  }
  const srt=path.join(dir,"subtitles.srt");
  let srtText="", n=1, cur=0;
  for(const sc of scenes){
    const sec=Number(sc.seconds)||8;
    const ff=x=>{let h=Math.floor(x/3600),m=Math.floor((x%3600)/60),s=x%60,ms=Math.round((x%1)*1000);return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")},${String(ms).padStart(3,"0")}`};
    srtText+=`${n++}\n${ff(cur)} --> ${ff(cur+sec)}\n${sc.narration}\n\n`; cur+=sec;
  }
  fs.writeFileSync(srt,srtText);

  await exec(process.env.FFMPEG_PATH||"ffmpeg",[
    "-y","-i",silent,"-i",audio,
    "-vf",`subtitles=${srt.replaceAll("\\","/").replaceAll(":","\\:")}:force_style='FontName=Arial,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=3,Alignment=2,MarginV=90'`,
    "-map","0:v:0","-map","1:a:0","-c:v","libx264","-preset","fast","-crf","20","-c:a","aac","-shortest",final
  ]);
  job.output=`/generated/${job.id}/clipflow-final.mp4`;
}

async function runPipeline(job){
  try{
    job.status="scripting"; job.progress=5;
    const sc=await openai.responses.create({
      model:process.env.TEXT_MODEL || "gpt-5.6",
      input:`Genera exactamente ${job.sceneCount} escenas para un short vertical de ${job.duration}s sobre: ${job.topic}. Estilo: ${job.style}. Devuelve SOLO JSON: {hook,cta,scenes:[{narration,visual_prompt,seconds}]}. Cada escena 4-8s.`
    });
    const data=JSON.parse(sc.output_text.replace(/^```json\s*|\s*```$/g,"").trim());
    job.data=data; job.status="generating"; job.scenes=[]; job.voices=[];
    for(let i=0;i<data.scenes.length;i++){
      const s=data.scenes[i]; job.progress=10+Math.round(i/data.scenes.length*65);
      const video=await createSoraClip(s.visual_prompt, s.seconds, job.dir, i);
      job.scenes.push({video,seconds:s.seconds,narration:s.narration});
      const voice=await createVoice(s.narration,job.dir,i); job.voices.push(voice);
    }
    job.status="assembling"; job.progress=85;
    await assemble(job,job.scenes);
    job.progress=100; job.status="completed";
  }catch(e){console.error(e);job.status="failed";job.error=e.message;}
}

app.post("/api/jobs", async(req,res)=>{
  const {topic,duration=30,style="Dinámico"}=req.body;
  if(!topic?.trim()) return res.status(400).json({error:"Falta topic"});
  const id=`job_${Date.now()}`;
  const dir=path.join(ROOT,id); fs.mkdirSync(dir,{recursive:true});
  const job={id,topic,duration:Number(duration),style,sceneCount:Math.max(3,Math.min(8,Math.ceil(Number(duration)/8))),status:"queued",progress:0,dir};
  jobs.set(id,job); runPipeline(job);
  res.status(202).json({id,status:job.status,progress:0});
});

app.get("/api/jobs/:id",(req,res)=>{
  const job=jobs.get(req.params.id);
  if(!job) return res.status(404).json({error:"Job no encontrado"});
  res.json({id:job.id,status:job.status,progress:job.progress,output:job.output,error:job.error,data:job.data});
});

// -------- Proyecto / biblioteca / programación --------
app.get("/api/projects", (_req,res)=>{
  const list=[...jobs.values()].map(j=>({
    id:j.id, topic:j.topic, status:j.status, progress:j.progress,
    output:j.output, createdAt:j.createdAt, data:j.data
  })).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
  res.json(list);
});

app.post("/api/projects/:id/metadata", (req,res)=>{
  const j=jobs.get(req.params.id);
  if(!j) return res.status(404).json({error:"Proyecto no encontrado"});
  j.metadata={caption:req.body.caption||"",hashtags:req.body.hashtags||[],music:req.body.music||"none"};
  saveJobs(); res.json(j.metadata);
});

// Pistas musicales locales: coloca MP3/WAV en generated/music/.
app.get("/api/music", (_req,res)=>{
  const dir=path.join(ROOT,"music"); fs.mkdirSync(dir,{recursive:true});
  const tracks=fs.readdirSync(dir).filter(x=>/\.(mp3|wav|m4a)$/i.test(x));
  res.json(tracks.map(name=>({name,url:`/generated/music/${encodeURIComponent(name)}`})));
});

// -------- Publicación social --------
// OAuth debe obtenerse por usuario y almacenarse cifrado en producción.
// TikTok: direct post / upload draft.
// YouTube/Instagram: adaptadores preparados para integrar sus OAuth respectivos.
async function tiktokPost({videoUrl,title,accessToken,privacy="SELF_ONLY",isAigc=true}){
  const creator=await fetch("https://open.tiktokapis.com/v2/post/publish/creator_info/query/",{
    method:"POST",headers:{Authorization:`Bearer ${accessToken}`,"Content-Type":"application/json"}
  }).then(r=>r.json());
  if(creator.error?.code && creator.error.code!=="ok") throw new Error(creator.error.message||"TikTok creator_info error");
  const privacyLevel=(creator.data?.privacy_level_options||[]).includes(privacy)?privacy:"SELF_ONLY";
  const init=await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/",{
    method:"POST",headers:{Authorization:`Bearer ${accessToken}`,"Content-Type":"application/json"},
    body:JSON.stringify({post_info:{title:title||"",privacy_level:privacyLevel,is_aigc:isAigc},
      source_info:{source:"PULL_FROM_URL",video_url:videoUrl}})
  }).then(r=>r.json());
  if(init.error?.code && init.error.code!=="ok") throw new Error(init.error.message||"TikTok publish error");
  return init.data;
}
app.post("/api/social/tiktok",async(req,res)=>{
  try{
    const {videoUrl,title,accessToken,privacy}=req.body;
    if(!accessToken||!videoUrl) return res.status(400).json({error:"Falta accessToken o videoUrl"});
    res.json(await tiktokPost({videoUrl,title,accessToken,privacy}));
  }catch(e){res.status(500).json({error:e.message});}
});

// Genera copy social con IA.
app.post("/api/social/copy",async(req,res)=>{
  try{
    const {topic,platform="tiktok",tone="viral"}=req.body;
    const r=await openai.responses.create({
      model:process.env.TEXT_MODEL||"gpt-5.6",
      input:`Crea copy para un video ${platform}. Tema: ${topic}. Tono: ${tone}.
Devuelve SOLO JSON: {"caption":"...","hashtags":["#...","#..."]}.`
    });
    res.json(JSON.parse(r.output_text.replace(/^```json\s*|\s*```$/g,"").trim()));
  }catch(e){res.status(500).json({error:e.message});}
});

// Webhook simple para integraciones externas.
app.post("/api/webhooks/:id",(req,res)=>{
  const j=jobs.get(req.params.id); if(!j) return res.sendStatus(404);
  j.webhook=req.body; saveJobs(); res.sendStatus(204);
});

app.listen(port,()=>console.log(`ClipFlow: http://localhost:${port}`));
