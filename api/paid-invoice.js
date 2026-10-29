"use strict";
const crypto = require('node:crypto');
const BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ORDER = /^BDJ-[A-HJ-NP-Z2-9]{4}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const BUCKET = 'real-payment-proofs';
function respond(res,status,body){res.setHeader('Cache-Control','no-store, private');res.setHeader('X-Content-Type-Options','nosniff');return res.status(status).json(body);}
async function get(path){const r=await fetch(BASE+path,{headers:{apikey:KEY,Authorization:`Bearer ${KEY}`},cache:'no-store',signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error('Database request failed');return r.json();}
module.exports=async function handler(req,res){
 if(req.method!=='POST'){res.setHeader('Allow','POST');return respond(res,405,{ok:false,message:'Method not allowed'});}
 if(!BASE||!KEY)return respond(res,503,{ok:false,message:'Layanan invoice belum siap'});
 try{
  const body=typeof req.body==='string'?JSON.parse(req.body):req.body;
  if(!body||Array.isArray(body)||typeof body!=='object'||Buffer.byteLength(JSON.stringify(body))>2048)return respond(res,400,{ok:false,message:'Permintaan tidak valid'});
  const number=String(body.order_number||'').trim().toUpperCase();
  const token=String(body.payment_access_token||'').trim();
  if(!ORDER.test(number)||!TOKEN.test(token))return respond(res,401,{ok:false,message:'Akses invoice tidak valid'});
  const query=new URLSearchParams({select:'id,order_number,buyer_name,buyer_email,buyer_phone,normal_qty,total_amount,payment_status,paid_at,payment_proof_path,payment_access_token_hash',order_number:`eq.${number}`,limit:'1'});
  const orders=await get('/rest/v1/orders?'+query);
  const o=orders?.[0];
  const supplied=crypto.createHash('sha256').update(token,'utf8').digest();
  const stored=o?.payment_access_token_hash;
  if(!o||typeof stored!=='string'||!TOKEN.test(stored)||!crypto.timingSafeEqual(supplied,Buffer.from(stored,'hex')))
   return respond(res,401,{ok:false,message:'Akses invoice tidak valid'});
  if(o.payment_status!=='PAID')return respond(res,403,{ok:false,message:'Invoice hanya tersedia setelah pembayaran disetujui OWNER'});
  if(!o.payment_proof_path||!o.payment_proof_path.startsWith(o.id+'/'))return respond(res,409,{ok:false,message:'Lampiran bukti pembayaran tidak ditemukan'});
  const pq=new URLSearchParams({select:'first_name,last_name,phone,jersey_size,booking_code',order_id:`eq.${o.id}`,order:'created_at.asc',limit:'10'});
  const participants=await get('/rest/v1/participants?'+pq);
  if(!Array.isArray(participants)||!participants.length)return respond(res,409,{ok:false,message:'Data peserta belum tersedia'});
  const path=o.payment_proof_path.split('/').map(encodeURIComponent).join('/');
  const proof=await fetch(`${BASE}/storage/v1/object/${BUCKET}/${path}`,{headers:{apikey:KEY,Authorization:`Bearer ${KEY}`},signal:AbortSignal.timeout(12000),cache:'no-store'});
  if(!proof.ok)return respond(res,503,{ok:false,message:'Lampiran bukti belum tersedia'});
  const mime=(proof.headers.get('content-type')||'').split(';')[0].toLowerCase();
  if(!['image/jpeg','image/png','image/webp'].includes(mime))return respond(res,503,{ok:false,message:'Format lampiran tidak didukung'});
  const bytes=Buffer.from(await proof.arrayBuffer());
  if(bytes.length>1048576)return respond(res,503,{ok:false,message:'Lampiran terlalu besar'});
  return respond(res,200,{ok:true,order:{order_number:o.order_number,buyer_name:o.buyer_name,buyer_email:o.buyer_email,buyer_phone:o.buyer_phone,total_participants:o.normal_qty,total_amount:o.total_amount,payment_status:o.payment_status,paid_at:o.paid_at},participants:participants.map(p=>({full_name:[p.first_name,p.last_name].filter(Boolean).join(' '),phone:p.phone,jersey_size:p.jersey_size,booking_code:p.booking_code})),proof_data_url:`data:${mime};base64,${bytes.toString('base64')}`});
 }catch(e){console.error('Paid invoice failed',e.message);return respond(res,503,{ok:false,message:'Invoice sementara tidak tersedia'});}
};
