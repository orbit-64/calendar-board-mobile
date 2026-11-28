'use strict';
const {identity,placeOf,stableId,overlaps,validatePlan}=require('./core.cjs');
const fs=require('node:fs');
const path=require('node:path');
const DEFAULT_URL='https://wnxfmendphwaiujllpag.supabase.co';
const DEFAULT_KEY='sb_publishable_lnUN_5q2iYUR8C5MXODnXw_XlpgW-4R';
class Cloud {
  constructor({url=DEFAULT_URL,key=DEFAULT_KEY,token='',fetchImpl=fetch}={}) {
    if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw new Error('检测到证书校验被关闭，拒绝连接；请先恢复正常TLS校验');
    if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url))throw new Error('只支持HTTPS Supabase项目地址');
    if(!key.startsWith('sb_publishable_'))throw new Error('请使用publishable key，不要使用secret/service_role key');
    this.url=url;this.key=key;this.token=token;this.refresh='';this.fetch=fetchImpl;
  }
  async request(route,method='GET',body=null,retry=true) {
    let response;
    try {response=await this.fetch(this.url+route,{method,redirect:'error',headers:{apikey:this.key,Accept:'application/json',...(this.token&&!route.startsWith('/auth/v1/token')?{Authorization:'Bearer '+this.token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});}
    catch(error){throw new Error('网络连接失败或等待超时；操作结果可能未确认，请查看导入报告后重新预检。未关闭证书校验。');}
    if(response.status===401&&retry&&this.refresh){
      const saved=await this.request('/auth/v1/token?grant_type=refresh_token','POST',{refresh_token:this.refresh},false);
      this.token=saved.access_token;this.refresh=saved.refresh_token;
      return this.request(route,method,body,false);
    }
    if(!response.ok){const error=new Error(`云端请求失败（HTTP ${response.status}），请检查登录状态、项目地址或版本冲突。`);error.status=response.status;throw error;}
    try{return await response.json();}catch{throw new Error('云端返回内容无效，请重新预检确认结果。');}
  }
  async login(email,password){const s=await this.request('/auth/v1/token?grant_type=password','POST',{email,password});this.token=s.access_token;this.refresh=s.refresh_token;return this.user();}
  async user(){const user=await this.request('/auth/v1/user');if(!/^[0-9a-f-]{36}$/i.test(user.id||''))throw new Error('无法确认登录账号');this.actor=user.id;return user;}
  async settings(){const rows=await this.request('/rest/v1/user_settings?select=semester_start,total_weeks,version');if(!Array.isArray(rows)||rows.length>1)throw new Error('学期设置返回异常');return rows[0]||{semester_start:'2026-08-31',total_weeks:18,version:0};}
  async rows(){const all=[];for(let offset=0;;offset+=1000){
    const rows=await this.request('/rest/v1/calendar_items?select=id,payload,status,deleted_at,version&order=id.asc&limit=1000&offset='+offset);
    if(!Array.isArray(rows))throw new Error('云端列表无效');all.push(...rows);if(rows.length<1000)break;if(all.length>100000)throw new Error('记录过多，请先联系维护者');
  }return all;}
  async create(id,item){
    const payload={...item,id};
    const result=await this.request('/rest/v1/rpc/calendar_save','POST',{p_id:id,p_expected:null,p_payload:payload,p_status:'active',p_deleted:false});
    if(!Array.isArray(result)||result.length!==1||result[0].id!==id||identity(result[0].payload)!==identity(item)||placeOf(result[0].payload)!==placeOf(item)||result[0].status!=='active'||result[0].deleted_at)throw new Error('未能确认新增结果，请重新预检；不要手动重复添加');
    return result[0];
  }
}
function preflight(plan,rows,actor,{allowOverlaps=false}={}){
  validatePlan(plan);
  const byId=new Map(),byKey=new Map();
  for(const row of rows){
    if(!row||!row.payload||typeof row.payload!=='object'||!/^([0-9a-f]{32})$/i.test(row.id||''))throw new Error('云端存在无法识别的记录，请先检查');
    byId.set(row.id,row);
    if(row.payload.type==='课程'){const key=identity(row.payload);if(!byKey.has(key))byKey.set(key,[]);byKey.get(key).push(row);}
  }
  const add=[],skip=[],conflicts=[];
  if((plan.warnings||[]).length&&!allowOverlaps)conflicts.push('预览内含课程重叠，确认保留时须加 --allow-overlaps');
  for(const item of plan.items){
    const id=stableId(actor,item),existing=byId.get(id),same=byKey.get(identity(item))||[];
    if(existing&&(existing.payload.type!=='课程'||identity(existing.payload)!==identity(item))){conflicts.push('稳定ID已被不同内容占用：'+item.date+' '+item.title);continue;}
    const matches=existing?[...new Set([...same,existing])]:same;
    if(matches.length){
      const changed=matches.some(row=>row.status==='active'&&!row.deleted_at&&placeOf(row.payload)!==placeOf(item));
      if(changed){conflicts.push('同一课程已有不同教室，保留原记录，请手动核对：'+item.date+' '+item.title);continue;}
      skip.push({id:matches[0].id,item,reason:matches.every(row=>row.status!=='active'||row.deleted_at)?'历史/已删除记录已存在，不恢复':'同一日期、时间、课程已存在'});
    }else add.push({id,item});
  }
  const old=rows.filter(row=>row.payload.type==='课程'&&row.status==='active'&&!row.deleted_at).map(row=>row.payload);
  const clash=[];
  for(const entry of add)for(const item of old)if(item.date===entry.item.date){
    for(const warning of overlaps([entry.item,item]))clash.push(warning);
    if(!/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(item.time||''))conflicts.push('已有课程缺少规范起止时间，无法检查重叠：'+item.date+' '+item.title);
  }
  if(!allowOverlaps)conflicts.push(...clash.map(x=>'与现有课程时间重叠：'+x));
  return {add,skip,conflicts:[...new Set(conflicts)],warnings:[...(plan.warnings||[]),...clash]};
}
function saveReport(file,value){
  const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',mode:0o600});fs.renameSync(temp,file);
}
async function applyPlan({plan,cloud,check,reportFile,stopRequested=()=>false}){
  validatePlan(plan);
  if(check.conflicts.length)throw new Error('预检存在冲突，未执行任何写入');
  const report={format:'calendar-timetable-result-v1',plan_sha256:plan.sha256,account_id:cloud.actor,started_at:new Date().toISOString(),status:'running',skipped:check.skip.map(x=>({id:x.id,date:x.item.date,title:x.item.title,reason:x.reason})),created:[],unconfirmed:[],error:null};
  saveReport(reportFile,report);
  for(const entry of check.add){
    if(stopRequested()){report.status='stopped';report.error='用户取消；已新增的课程保留，重新执行相同预览可跳过已导入内容';break;}
    try{
      await cloud.create(entry.id,entry.item);
      report.created.push({id:entry.id,date:entry.item.date,title:entry.item.title});saveReport(reportFile,report);
    }catch(error){
      report.status='partial';report.error=error.message;report.unconfirmed.push({id:entry.id,date:entry.item.date,title:entry.item.title});saveReport(reportFile,report);return report;
    }
  }
  if(report.status==='running')report.status='complete';report.finished_at=new Date().toISOString();saveReport(reportFile,report);return report;
}
module.exports={Cloud,preflight,applyPlan,DEFAULT_URL,DEFAULT_KEY};
