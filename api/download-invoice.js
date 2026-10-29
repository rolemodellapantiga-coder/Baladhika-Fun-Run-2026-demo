'use strict';
const crypto = require('node:crypto');
const BASE=(process.env.SUPABASE_URL||'').replace(/\/+$/,'');
const KEY=process.env.SUPABASE_SERVICE_ROLE_KEY||'';
const ORDER=/^BDJ-[A-HJ-NP-Z2-9]{4}$/;
const respond=(res,status,error)=>res.status(status).json({success:false,error});
function pdfText(value){return String(value??'').normalize('NFKD').replace(/[^\x20-\x7E]/g,' ').replace(/[\\()]/g,'\\$&').slice(0,105);}
function pdf(lines){
  const cmds=['BT','/F1 16 Tf','50 785 Td',`(${pdfText('INVOICE - BALADHIKA FUN RUN 2026')}) Tj`,'/F1 11 Tf'];
  for(const line of lines){cmds.push('0 -27 Td',`(${pdfText(line)}) Tj`);}
  cmds.push('ET');
  const content=cmds.join('\n');
  const objects=[null,'<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  const chunks=['%PDF-1.4\n'];let offset=Buffer.byteLength(chunks[0]);const offsets=[0];
  for(let i=1;i<objects.length;i++){offsets[i]=offset;const str=`${i} 0 obj\n${objects[i]}\nendobj\n`;chunks.push(str);offset+=Buffer.byteLength(str);}
  const xref=offset;chunks.push(`xref\n0 ${objects.length}\n0000000000 65535 f \n`);
  for(let i=1;i<objects.length;i++)chunks.push(String(offsets[i]).padStart(10,'0')+' 00000 n \n');
  chunks.push(`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return Buffer.from(chunks.join(''),'utf8');
}
module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store, private');res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='POST'){res.setHeader('Allow','POST');return respond(res,405,'Metode tidak diizinkan.');}
  if(!BASE||!KEY)return respond(res,503,'Server belum siap.');
  let body=req.body;try{if(typeof body==='string')body=JSON.parse(body);}catch{return respond(res,400,'Data tidak valid.');}
  if(!body||typeof body!=='object'||Buffer.byteLength(JSON.stringify(body))>2048)return respond(res,400,'Data tidak valid.');
  const number=String(body.order_number||'').trim().toUpperCase();
  const email=String(body.buyer_email||'').trim().toLowerCase();
  if(!ORDER.test(number)||email.length>254||!/^\S+@\S+\.\S+$/.test(email))return respond(res,400,'Nomor pesanan atau email tidak valid.');
  try{
    const q=new URLSearchParams({select:'order_number,buyer_name,buyer_email,normal_qty,total_amount,payment_status,paid_at',order_number:`eq.${number}`,limit:'1'});
    const r=await fetch(`${BASE}/rest/v1/orders?${q}`,{headers:{apikey:KEY,Authorization:`Bearer ${KEY}`},cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw Error('Supabase '+r.status);
    const rows=await r.json();const o=rows?.[0];
    const actual=String(o?.buyer_email||'').trim().toLowerCase();
    // Compare hashes to reduce timing differences for email checks.
    const a=crypto.createHash('sha256').update(email).digest();
    const b=crypto.createHash('sha256').update(actual).digest();
    if(!o||!crypto.timingSafeEqual(a,b))return respond(res,403,'Data verifikasi tidak cocok.');
    if(o.payment_status!=='PAID')return respond(res,403,'Invoice tersedia setelah pembayaran diverifikasi OWNER.');
    const amount=Number(o.total_amount);
    if(!Number.isFinite(amount)||amount<0)return respond(res,503,'Data tagihan tidak valid.');
    const lines=[
      'BALADHIKA FUN RUN 2026 | 5K',
      '6 Desember 2026 - Lapangan Rampal, Kota Malang',
      '--------------------------------------------',
      `Nomor Pesanan : ${o.order_number}`,
      `Nama Pemesan  : ${o.buyer_name||'-'}`,
      `Kategori      : REGULER`,
      `Jumlah Peserta: ${o.normal_qty||'-'}`,
      `Total Dibayar : Rp ${amount.toLocaleString('id-ID')}`,
      `Status        : LUNAS (terverifikasi OWNER)`,
      `Tanggal Lunas : ${o.paid_at?new Date(o.paid_at).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'}):'-'}`,
      '--------------------------------------------',
      'Invoice ini adalah catatan pembayaran pesanan.',
      'Bukan bukti pembayaran bank atau tiket masuk.'
    ];
    const bytes=pdf(lines);
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="INVOICE-${number}.pdf"`);
    res.setHeader('Content-Length',String(bytes.length));
    return res.status(200).send(bytes);
  }catch(e){console.error('Invoice download:',e.message);return respond(res,503,'Invoice sementara tidak tersedia.');}
};
