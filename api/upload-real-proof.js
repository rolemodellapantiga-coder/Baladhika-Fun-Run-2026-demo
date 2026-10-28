"use strict";
const crypto = require('node:crypto');
const BASE = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'real-payment-proofs';
const ORDER = /^BDJ-[A-HJ-NP-Z2-9]{4}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const MIME = {'image/jpeg':'jpg','image/png':'png','image/webp':'webp'};
function respond(res,code,message,extra={}) {res.setHeader('Cache-Control','no-store, private');return res.status(code).json({ok:code>=200&&code<300,message,...extra});}
function headers(extra={}) {return {apikey:KEY,Authorization:`Bearer ${KEY}`,...extra};}
async function request(path,options={}) {const r=await fetch(`${BASE}${path}`,{...options,headers:headers(options.headers),signal:AbortSignal.timeout(12000),cache:'no-store'});const data=await r.json().catch(()=>null);if(!r.ok)throw Error(`Supabase ${r.status}`);return data;}
function signatureValid(b,m){if(m==='image/png')return b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));if(m==='image/jpeg')return b.length>4&&b[0]===255&&b[1]===216&&b.at(-2)===255&&b.at(-1)===217;if(m==='image/webp')return b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP';return false;}
module.exports=async function handler(req,res){
 if(req.method!=='POST')return respond(res,405,'Gunakan POST.');
 if(!BASE||!KEY)return respond(res,503,'Konfigurasi server belum lengkap.');
 const body=typeof req.body==='string'?(()=>{try{return JSON.parse(req.body)}catch{return {}}})():req.body||{};
 const number=typeof body.order_number==='string'?body.order_number.trim().toUpperCase():'';
 const token=typeof body.session_token==='string'?body.session_token.trim():'';
 const mime=body.mime_type;
 if(!ORDER.test(number)||!TOKEN.test(token))return respond(res,401,'Sesi tidak valid.');
 if(!Object.hasOwn(MIME,mime)||typeof body.file_base64!=='string'||body.file_base64.length>1400000||!/^[A-Za-z0-9+/]+={0,2}$/.test(body.file_base64))return respond(res,400,'Bukti harus JPG, PNG, atau WebP maksimal 1 MB.');
 const buffer=Buffer.from(body.file_base64,'base64');
 if(buffer.length<16||buffer.length>1048576||!signatureValid(buffer,mime))return respond(res,400,'Gambar tidak valid atau terlalu besar.');
 try{
  const hash=crypto.createHash('sha256').update(token).digest('hex');
  const validated=await request('/rest/v1/rpc/validate_real_payment_session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_order_number:number,p_token_hash:hash})});
  const session=Array.isArray(validated)?validated[0]:validated;
  if(!session?.order_id||session.order_number!==number)return respond(res,401,'Sesi tidak valid atau telah berakhir.');
  const q=new URLSearchParams({select:'id,payment_status,payment_review_status,payment_proof_path,payment_expires_at,expiry_policy_version',id:`eq.${session.order_id}`,limit:'1'});
  const rows=await request(`/rest/v1/orders?${q}`);const order=rows?.[0];
  if(!order||order.payment_status!=='PENDING_PAYMENT')return respond(res,409,'Pesanan tidak dapat menerima bukti pembayaran.');
  if(order.payment_proof_path||order.payment_review_status==='WAITING')return respond(res,409,'Bukti sudah diunggah. Hubungi admin jika perlu mengganti.');
  if(order.expiry_policy_version!==0&&order.payment_expires_at&&Date.parse(order.payment_expires_at)<=Date.now())return respond(res,410,'Batas pembayaran telah lewat.');
  const path=`${order.id}/${crypto.randomUUID()}.${MIME[mime]}`;
  const uploaded=await fetch(`${BASE}/storage/v1/object/${BUCKET}/${path}`,{method:'POST',headers:headers({'Content-Type':mime,'x-upsert':'false'}),body:buffer,signal:AbortSignal.timeout(12000)});
  if(!uploaded.ok)throw Error(`Storage ${uploaded.status}`);
  const filter=new URLSearchParams({id:`eq.${order.id}`,payment_status:'eq.PENDING_PAYMENT',payment_proof_path:'is.null',select:'id'});
  const updated=await request(`/rest/v1/orders?${filter}`,{method:'PATCH',headers:{'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify({payment_proof_path:path,payment_proof_uploaded_at:new Date().toISOString(),payment_review_status:'WAITING'})});
  if(!Array.isArray(updated)||updated.length!==1){await fetch(`${BASE}/storage/v1/object/${BUCKET}/${path}`,{method:'DELETE',headers:headers()}).catch(()=>{});return respond(res,409,'Bukti sudah diproses. Muat ulang pesanan.');}
  return respond(res,200,'Bukti diterima dan menunggu verifikasi admin.',{order_number:number,review_status:'WAITING'});
 }catch(e){console.error('upload-real-proof:',e.message);return respond(res,503,'Unggahan belum berhasil. Coba lagi nanti.');}
};
