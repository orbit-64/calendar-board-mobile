'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const DAY = 86400000;
const DEFAULT_PERIODS = {
  1:['08:30','09:15'],2:['09:20','10:05'],3:['10:20','11:05'],4:['11:10','11:55'],
  5:['14:30','15:15'],6:['15:20','16:05'],7:['16:20','17:05'],8:['17:10','17:55'],
  9:['19:30','20:15'],10:['20:20','21:05'],11:['21:10','21:55'],12:['22:00','22:45']
};
function fail(message) { throw new Error(message); }
function isoDate(value) {
  const s=String(value??'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s))fail(`日期格式无效：${s}，应为 YYYY-MM-DD`);
  const n=Date.parse(s+'T00:00:00Z');
  if(!Number.isFinite(n)||new Date(n).toISOString().slice(0,10)!==s)fail(`不存在的日期：${s}`);
  return n;
}
function dateAt(n) { return new Date(n).toISOString().slice(0,10); }
function integer(value,min,max,name) {
  if(!/^\d+$/.test(String(value??''))||Number(value)<min||Number(value)>max)fail(`${name}应为${min}～${max}的整数`);
  return Number(value);
}
function text(value,name,max=1000) {
  const s=String(value??'').trim();
  if(!s||s.length>max||/[\u0000-\u001f]/.test(s))fail(`${name}不能为空、不能含换行或控制字符，最多${max}字`);
  return s;
}
function time(value) {
  const s=String(value??'').trim();
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(s))fail(`时间无效：${s}，应为 HH:mm`);
  return s;
}
function normalize(value) { return String(value??'').normalize('NFKC').trim().replace(/\s+/g,' '); }
function identity(item) { return [item.date,item.time,normalize(item.title)].join('|'); }
function placeOf(item) { return normalize(item.place || item.room || ''); }
function stableId(actor,item) {
  if(!/^[0-9a-f-]{36}$/i.test(actor))fail('登录账号ID无效');
  return crypto.createHash('sha256').update(JSON.stringify(['timetable-import-v1',actor.toLowerCase(),identity(item)])).digest('hex').slice(0,32);
}
function config(raw) {
  const start=String(raw.semester_start??'');const n=isoDate(start);
  if(start<'2000-01-01'||start>'2100-12-31'||new Date(n).getUTCDay()!==1)fail('学期起点必须是2000～2100年间第一周的周一');
  const weeks=integer(raw.total_weeks,1,60,'总周数');
  const periods=raw.periods??DEFAULT_PERIODS;
  if(!periods||typeof periods!=='object'||Array.isArray(periods))fail('节次时间表必须为对象');
  for(const [key,pair] of Object.entries(periods)) {
    integer(key,1,30,'节次');
    if(!Array.isArray(pair)||pair.length!==2||time(pair[0])>=time(pair[1]))fail(`第${key}节时间无效`);
  }
  return {semester_start:start,total_weeks:weeks,periods};
}
function parseCsv(input) {
  input=input.replace(/^\uFEFF/,'');
  const records=[];let row=[],cell='',quoted=false,closed=false;
  for(let i=0;i<=input.length;i++) {
    const c=i===input.length?'\n':input[i];
    if(quoted) {
      if(i===input.length)fail('CSV引号未闭合');
      if(c==='"'&&input[i+1]==='"'){cell+='"';i++;}else if(c==='"'){quoted=false;closed=true;}else cell+=c;
    } else if(c==='"') {
      if(cell||closed)fail('CSV引号位置无效');quoted=true;
    } else if(c===','||c==='\n'||c==='\r') {
      row.push(cell);cell='';closed=false;
      if(c!==','){if(c==='\r'&&input[i+1]==='\n')i++;if(row.some(x=>x.trim()))records.push(row);row=[];}
    } else {if(closed)fail('CSV引号后应为逗号或换行');cell+=c;}
  }
  if(records.length<2)fail('CSV至少需要表头和一行课程');
  const aliases={'课程名':'title','星期':'weekday','开始时间':'start_time','结束时间':'end_time','起始周':'start_week','结束周':'end_week','单双周':'week_pattern','教室':'place','起始节':'start_period','结束节':'end_period','指定周次':'weeks'};
  const columns=records.shift().map(s=>aliases[s.trim()]||s.trim());
  const allowed=new Set(['title','weekday','start_time','end_time','start_week','end_week','week_pattern','place','start_period','end_period','weeks']);
  if(new Set(columns).size!==columns.length||columns.some(x=>!allowed.has(x)))fail('CSV包含重复或未知表头，请使用提供的模板');
  return records.map((r,i)=>{
    if(r.length!==columns.length)fail(`CSV第${i+2}行列数不一致`);
    return Object.fromEntries(columns.map((key,n)=>[key,r[n].trim()]));
  });
}
function weekList(rule,total) {
  let list=[];
  if(rule.weeks) {
    for(const part of String(rule.weeks).split(/[;,；，]/)) {
      const m=part.trim().match(/^(\d+)(?:-(\d+))?$/);
      if(!m)fail(`指定周次无效：${part}`);
      const a=integer(m[1],1,total,'周次'),b=integer(m[2]??m[1],1,total,'周次');
      if(a>b)fail('指定周次范围不能倒置');
      for(let w=a;w<=b;w++)list.push(w);
    }
    if(rule.start_week||rule.end_week)fail('指定周次与起止周二选一填写');
  } else {
    const a=integer(rule.start_week,1,total,'起始周'),b=integer(rule.end_week,1,total,'结束周');
    if(a>b)fail('起始周不能晚于结束周');
    for(let w=a;w<=b;w++)list.push(w);
  }
  const pattern=String(rule.week_pattern||'all').trim();
  const parity={all:0,'每周':0,'全部':0,odd:1,'单周':1,even:2,'双周':2}[pattern];
  if(parity===undefined)fail(`单双周无效：${pattern}`);
  list=[...new Set(list)].sort((a,b)=>a-b).filter(w=>!parity||(parity===1?w%2===1:w%2===0));
  if(!list.length)fail('指定范围和单双周组合没有任何上课周');
  return list;
}
function weekday(raw) {
  const s=String(raw??'').trim();const chinese={'周一':1,'周二':2,'周三':3,'周四':4,'周五':5,'周六':6,'周日':7,'周天':7,'星期一':1,'星期二':2,'星期三':3,'星期四':4,'星期五':5,'星期六':6,'星期日':7,'星期天':7};
  return chinese[s]||integer(s,1,7,'星期（周一为1）');
}
function course(title,date,start,end,place,week) {
  title=text(title,'课程名');isoDate(date);start=time(start);end=time(end);
  if(end<=start)fail('结束时间必须晚于开始时间；跨午夜课程请拆为两条');
  place=place?text(place,'教室',200):'';
  return {type:'课程',title,date,time:`${start}-${end}`,startTime:start,endTime:end,place,room:place,week,done:false,source:'timetable-import-v1'};
}
function expandRules(rules,settings) {
  if(!Array.isArray(rules)||!rules.length||rules.length>500)fail('课程规则应为1～500行');
  const cfg=config(settings),items=[],base=isoDate(cfg.semester_start);
  rules.forEach((rule,i)=>{
    try {
      if(!rule||typeof rule!=='object'||Array.isArray(rule))fail('规则应为对象');
      const allowed=new Set(['title','weekday','start_time','end_time','start_week','end_week','week_pattern','place','start_period','end_period','weeks']);
      for(const key of Object.keys(rule))if(!allowed.has(key))fail(`未知字段：${key}`);
      const day=weekday(rule.weekday);let a,b;
      if(rule.start_period||rule.end_period){
        if(rule.start_time||rule.end_time)fail('时间和节次二选一填写');
        const first=integer(rule.start_period,1,30,'起始节'),last=integer(rule.end_period,1,30,'结束节');
        if(first>last||!cfg.periods[first]||!cfg.periods[last])fail('节次范围无效或时间表缺少节次');
        for(let p=first;p<=last;p++){if(!cfg.periods[p]||(p>first&&cfg.periods[p-1][1]>cfg.periods[p][0]))fail('节次表缺项或顺序重叠');}
        a=cfg.periods[first][0];b=cfg.periods[last][1];
      }else{a=rule.start_time;b=rule.end_time;}
      for(const week of weekList(rule,cfg.total_weeks)){items.push(course(rule.title,dateAt(base+((week-1)*7+day-1)*DAY),a,b,rule.place,week));if(items.length>10000)fail('展开后超过10000节，请分学期导入');}
    }catch(error){fail(`第${i+1}条规则：${error.message}`);}
  });
  return items;
}

// Supported ICS subset: concrete events and weekly recurrence in Shanghai, UTC,
// or floating local time. Unsupported rules are rejected, never silently omitted.
function unescapeIcs(value){return value.replace(/\\[nN]/g,' ').replace(/\\([,;\\])/g,'$1');}
function icsStamp(prop) {
  const match=prop.value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if(!match)fail('ICS课程须有明确开始、结束时间（不支持全天课程）');
  if(prop.params.TZID&&!['Asia/Shanghai','Asia/Chongqing','Asia/Hong_Kong','UTC','Etc/UTC'].includes(prop.params.TZID))fail(`暂不支持ICS时区 ${prop.params.TZID}，请先导出北京时间或UTC`);
  const [,y,m,d,h,minute,sec,z]=match;
  if(sec!=='00')fail('ICS包含秒级时间，请先调整为整分钟');
  const date=`${y}-${m}-${d}`,clock=`${h}:${minute}`;isoDate(date);time(clock);
  const utc=z||['UTC','Etc/UTC'].includes(prop.params.TZID);
  return isoDate(date)+(Number(h)*60+Number(minute))*60000+(utc?8*3600000:0);
}
function parseIcs(input,settings) {
  const cfg=config(settings),base=isoDate(cfg.semester_start),end=base+cfg.total_weeks*7*DAY;
  const lines=input.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n').replace(/\n[ \t]/g,'').split('\n');
  if(!lines.includes('BEGIN:VCALENDAR')||!lines.includes('END:VCALENDAR'))fail('不是有效的VCALENDAR文件');
  const events=[];let event=null,nested=0;
  for(const line of lines){
    if(line==='BEGIN:VEVENT'){if(event)fail('ICS事件嵌套无效');event=[];continue;}
    if(line==='END:VEVENT'){if(!event)fail('ICS事件结束标记无效');events.push(event);event=null;continue;}
    if(!event)continue;
    if(line.startsWith('BEGIN:')){nested++;continue;}if(line.startsWith('END:')){nested--;continue;}if(nested)continue;
    const colon=line.indexOf(':');if(colon<1)continue;
    const [name,...param]=line.slice(0,colon).split(';');const params={};for(const part of param){const at=part.indexOf('=');if(at<1)fail('ICS参数无效');params[part.slice(0,at)]=part.slice(at+1).replace(/^"|"$/g,'');}
    event.push({name,params,value:line.slice(colon+1)});
  }
  if(event||nested||!events.length||events.length>500)fail('ICS事件不完整或数量超出500条规则');
  const items=[];let excluded=0;
  events.forEach((props,index)=>{
    try {
      const all=name=>props.filter(p=>p.name===name),one=name=>{const a=all(name);if(a.length>1)fail(`ICS字段${name}重复`);return a[0];};
      if(one('RECURRENCE-ID'))fail('ICS含有单次调课覆盖，请先导出展开后的具体事件，避免漏课');
      if(one('STATUS')?.value==='CANCELLED')return;
      if(one('EXRULE')||one('DURATION'))fail('ICS含未支持的EXRULE或DURATION，请导出具体起止时间');
      const title=one('SUMMARY'),dtstart=one('DTSTART'),dtend=one('DTEND');
      if(!title||!dtstart||!dtend)fail('ICS事件缺少课程名、DTSTART或DTEND');
      const start=icsStamp(dtstart),finish=icsStamp(dtend),duration=finish-start;
      if(duration<=0||Math.floor(start/DAY)!==Math.floor((finish-1)/DAY)||finish%DAY===0)fail('ICS课程时间无效或跨午夜，请拆分课程');
      const occurrences=[];const recurrence=one('RRULE');
      if(recurrence){
        const fields={};for(const part of recurrence.value.split(';')){const [k,v,...rest]=part.split('=');if(!v||rest.length||fields[k])fail('ICS重复规则无效');fields[k]=v;}
        if(Object.keys(fields).some(k=>!['FREQ','INTERVAL','BYDAY','COUNT','UNTIL','WKST'].includes(k))||fields.FREQ!=='WEEKLY'||(fields.WKST&&fields.WKST!=='MO'))fail('ICS仅支持以周一为周起点的WEEKLY规则；其他规则请先展开导出');
        if(fields.COUNT&&fields.UNTIL)fail('ICS的COUNT与UNTIL不能同时出现');
        const interval=integer(fields.INTERVAL||1,1,60,'ICS周间隔');
        const limit=fields.COUNT?integer(fields.COUNT,1,10000,'ICS次数'):Infinity;
        let until=end-1;
        if(fields.UNTIL)until=icsStamp({value:fields.UNTIL,params:dtstart.params});
        const names=['MO','TU','WE','TH','FR','SA','SU'];
        const offset=dtstart.value.endsWith('Z')||['UTC','Etc/UTC'].includes(dtstart.params.TZID)?8*3600000:0;
        const sourceStart=start-offset;
        const dow=(new Date(sourceStart).getUTCDay()+6)%7;
        const days=fields.BYDAY?fields.BYDAY.split(',').map(n=>{const d=names.indexOf(n);if(d<0)fail('ICS BYDAY无效');return d;}):[dow];
        if(!days.includes(dow))fail('ICS DTSTART与BYDAY不一致');
        const monday=Math.floor(sourceStart/DAY)*DAY-dow*DAY,timeOfDay=sourceStart%DAY;let count=0;
        for(let week=0;monday+week*7*DAY+offset<Math.min(end,until+1);week+=interval){
          for(const day of [...new Set(days)].sort((a,b)=>a-b)){
            const when=monday+(week*7+day)*DAY+timeOfDay+offset;
            if(when<start||when>until||count>=limit)continue;count++;occurrences.push(when);
          }
          if(count>=limit)break;
        }
      } else occurrences.push(start);
      for(const prop of all('RDATE'))for(const v of prop.value.split(','))occurrences.push(icsStamp({...prop,value:v}));
      const exceptions=new Set();for(const prop of all('EXDATE'))for(const v of prop.value.split(','))exceptions.add(icsStamp({...prop,value:v}));
      for(const when of new Set(occurrences)){
        if(exceptions.has(when))continue;if(when<base||when>=end){excluded++;continue;}
        const date=dateAt(when),a=new Date(when).toISOString().slice(11,16),b=new Date(when+duration).toISOString().slice(11,16);
        items.push(course(unescapeIcs(title.value),date,a,b,unescapeIcs(one('LOCATION')?.value||''),Math.floor((isoDate(date)-base)/(7*DAY))+1));
        if(items.length>10000)fail('展开后超过10000节，请分学期导入');
      }
    } catch(error){fail(`ICS第${index+1}个事件：${error.message}`);}
  });
  if(!items.length)fail('所选学期内没有可导入的ICS课程');
  return {items,excluded};
}
function timeRange(item){const m=String(item.time||'').match(/^(\d\d:\d\d)-(\d\d:\d\d)$/);return m?[time(m[1]),time(m[2])]:null;}
function overlaps(items) {
  const sorted=[...items].sort((a,b)=>a.date.localeCompare(b.date)||a.time.localeCompare(b.time));const found=[];
  for(let i=0;i<sorted.length;i++)for(let j=i+1;j<sorted.length&&sorted[j].date===sorted[i].date;j++){
    const a=timeRange(sorted[i]),b=timeRange(sorted[j]);
    if(a&&b&&a[0]<b[1]&&b[0]<a[1])found.push(`${sorted[i].date}：${sorted[i].title} ${sorted[i].time} 与 ${sorted[j].title} ${sorted[j].time}`);
  }
  return found;
}
function digest(value){return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function planHash(plan){const copy={...plan};delete copy.sha256;return digest(copy);}
function createPlan(input,settings,{name='',allowOverlaps=false}={}) {
  const cfg=config(settings);let items,excluded=0;
  if(path.extname(name).toLowerCase()==='.ics')({items,excluded}=parseIcs(input,cfg));
  else {const rules=path.extname(name).toLowerCase()==='.csv'?parseCsv(input):JSON.parse(input.replace(/^\uFEFF/,''));items=expandRules(Array.isArray(rules)?rules:rules.courses,cfg);}
  const unique=new Map();let duplicates=0;
  for(const item of items){const key=identity(item);if(unique.has(key)){if(placeOf(unique.get(key))!==placeOf(item))fail(`同一课程重复且教室不同：${key}`);duplicates++;}else unique.set(key,item);}
  items=[...unique.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.time.localeCompare(b.time)||a.title.localeCompare(b.title));
  if(items.length>10000)fail('展开后超过10000条，请分学期导入');
  const conflicts=overlaps(items);if(conflicts.length&&!allowOverlaps)fail(`发现${conflicts.length}处课程时间重叠，请先修正；如确需保留，可用 --allow-overlaps 生成含警告的预览。\n${conflicts.slice(0,8).join('\n')}`);
  const plan={format:'calendar-timetable-plan-v1',semester:{semester_start:cfg.semester_start,total_weeks:cfg.total_weeks},source_name:path.basename(name),source_sha256:crypto.createHash('sha256').update(input).digest('hex'),created_at:new Date().toISOString(),duplicates_removed:duplicates,excluded_occurrences:excluded,warnings:conflicts,items};
  plan.sha256=planHash(plan);return plan;
}
function validatePlan(plan) {
  if(plan.format!=='calendar-timetable-plan-v1'||planHash(plan)!==plan.sha256)fail('预览文件校验失败，请重新生成，不要手工编辑预览JSON');
  const cfg=config(plan.semester),base=isoDate(cfg.semester_start),end=base+cfg.total_weeks*7*DAY;
  if(!Array.isArray(plan.items)||!plan.items.length||plan.items.length>10000)fail('预览课程数量无效');
  const seen=new Set();
  for(const item of plan.items){
    const [a,b]=String(item.time).split('-');const rebuilt=course(item.title,item.date,a,b,item.place,item.week);
    if(item.startTime!==rebuilt.startTime||item.endTime!==rebuilt.endTime||item.room!==item.place)fail('预览中的时间或教室字段不一致');
    const stamp=isoDate(item.date);
    if(item.type!=='课程'||stamp<base||stamp>=end||item.week!==Math.floor((stamp-base)/(7*DAY))+1||item.done!==false||item.source!=='timetable-import-v1')fail('预览内容不符合课程导入规则');
    const k=identity(item);if(seen.has(k))fail('预览文件包含重复课程');seen.add(k);
  }
  return plan;
}
function htmlPreview(plan) {
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const rows=plan.items.map(i=>`<tr><td>${esc(i.date)}</td><td>第${i.week}周</td><td>${esc(i.time)}</td><td>${esc(i.title)}</td><td>${esc(i.place)}</td></tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>课表导入预览</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#f1f5f9;color:#1c2d3d;margin:24px}main{max-width:1100px;margin:auto}h1{color:#167174}table{border-collapse:collapse;width:100%;background:white}th,td{padding:10px;text-align:left;border-bottom:1px solid #dbe4e8;overflow-wrap:anywhere}th{background:#e5f0f1}code{overflow-wrap:anywhere}.warn{color:#9c3a22}</style><main><h1>课表导入预览 · ${plan.items.length} 节</h1><p>第一周周一：${esc(plan.semester.semester_start)} · ${plan.semester.total_weeks} 周。此页仅供核对，没有上传任何数据。</p><p>输入内重复合并 ${plan.duplicates_removed} 条；学期外具体事件忽略 ${plan.excluded_occurrences} 条。</p>${plan.warnings.map(w=>`<p class="warn">重叠提醒：${esc(w)}</p>`).join('')}<p>校验值：<code>${esc(plan.sha256)}</code></p><table><thead><tr><th>日期</th><th>周次</th><th>时间</th><th>课程</th><th>教室</th></tr></thead><tbody>${rows}</tbody></table></main></html>`;
}
module.exports={config,isoDate,dateAt,identity,placeOf,stableId,parseCsv,expandRules,parseIcs,overlaps,createPlan,validatePlan,htmlPreview,planHash,DEFAULT_PERIODS};
