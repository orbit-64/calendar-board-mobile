'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const core=require('../core.cjs');const {Cloud,preflight,applyPlan}=require('../cloud.cjs');
const cfg={semester_start:'2027-03-01',total_weeks:20};
const actor='68b3e876-61b8-475f-a065-744bc48ac801',other='68b3e876-61b8-475f-a065-744bc48ac802';
function rule(overrides={}){return {title:'数学',weekday:1,start_time:'08:30',end_time:'10:05',start_week:1,end_week:3,place:'A101',...overrides};}
function plan(rules=[rule()],options={}){return core.createPlan(JSON.stringify(rules),cfg,{name:'课程.json',...options});}
function row(item,extra={}){return {id:core.stableId(actor,item),payload:{...item},status:'active',deleted_at:null,version:1,...extra};}
function ics(extra='',stamp='DTSTART;TZID=Asia/Shanghai:20270301T083000\nDTEND;TZID=Asia/Shanghai:20270301T100500'){return `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:test@example.invalid\n${stamp}\nSUMMARY:课程\nLOCATION:A101\n${extra}\nEND:VEVENT\nEND:VCALENDAR`;}

test('每周、单双周、星期与跨年展开日期准确',()=>{
  assert.deepEqual(core.expandRules([rule()],cfg).map(x=>x.date),['2027-03-01','2027-03-08','2027-03-15']);
  assert.deepEqual(core.expandRules([rule({week_pattern:'odd'})],cfg).map(x=>x.week),[1,3]);
  assert.deepEqual(core.expandRules([rule({week_pattern:'even'})],cfg).map(x=>x.week),[2]);
  assert.equal(core.expandRules([rule({weekday:'周日'})],cfg)[0].date,'2027-03-07');
  const next=core.expandRules([rule()],{semester_start:'2026-12-28',total_weeks:3});assert.equal(next[1].date,'2027-01-04');
});
test('指定周次、去重与节次表',()=>{
  const r=rule({weeks:'1-3;3;5',start_week:'',end_week:'',week_pattern:'odd'});
  assert.deepEqual(core.expandRules([r],cfg).map(x=>x.week),[1,3,5]);
  assert.equal(core.expandRules([rule({start_time:'',end_time:'',start_period:9,end_period:12})],cfg)[0].time,'19:30-22:45');
  assert.equal(core.expandRules([rule({start_time:'',end_time:'',start_period:1,end_period:2})],{...cfg,periods:{1:['09:00','09:40'],2:['09:50','10:30']}})[0].time,'09:00-10:30');
});
test('无效日期、范围、时间、字段不会静默跳过',()=>{
  for(const c of [{...cfg,semester_start:'2027-03-02'},{...cfg,total_weeks:0},{...cfg,total_weeks:61},{...cfg,semester_start:'2027-02-30'}])assert.throws(()=>core.config(c));
  for(const r of [rule({weekday:0}),rule({end_week:21}),rule({start_week:4}),rule({start_time:'08:99'}),rule({end_time:'08:00'}),rule({week_pattern:'单'}),rule({weeks:'1;bad',start_week:'',end_week:''}),rule({weeks:'2',start_week:'',end_week:'',week_pattern:'odd'}),rule({typo:true}),rule({start_period:1})])assert.throws(()=>core.expandRules([r],cfg));
});
test('CSV引号、逗号、中文表头与BOM；拒绝残缺CSV',()=>{
  const csv='\uFEFF课程名,星期,开始时间,结束时间,起始周,结束周,单双周,教室\r\n"数学,进阶",周一,08:30,10:05,1,2,每周,"A""101"\r\n';
  const rows=core.parseCsv(csv);assert.equal(rows[0].title,'数学,进阶');assert.equal(rows[0].place,'A"101');assert.equal(core.expandRules(rows,cfg).length,2);
  for(const broken of ['title,title\nx,y','title,weekday\n"未闭合,1','title,weekday\n数学,1,2','title,unknown\n数学,1'])assert.throws(()=>core.parseCsv(broken));
});
test('模板CSV/JSON/ICS均可生成有效计划',()=>{
  for(const name of ['courses.csv','courses-periods.csv','courses.json','courses.ics']){
    const file=path.join(__dirname,'../templates',name);const p=core.createPlan(fs.readFileSync(file,'utf8'),cfg,{name:file});assert.ok(p.items.length);core.validatePlan(p);
  }
});
test('输入内重复合并；不同教室与时间重叠阻止预览',()=>{
  const p=plan([rule(),rule()]);assert.equal(p.items.length,3);assert.equal(p.duplicates_removed,3);
  assert.throws(()=>plan([rule(),rule({place:'B202'})]),/教室不同/);
  assert.throws(()=>plan([rule(),rule({title:'英语',start_time:'09:00'})]),/重叠/);
  const allowed=plan([rule(),rule({title:'英语',start_time:'09:00'})],{allowOverlaps:true});assert.ok(allowed.warnings.length);
  assert.ok(preflight(allowed,[],actor).conflicts.length);assert.equal(preflight(allowed,[],actor,{allowOverlaps:true}).conflicts.length,0);
});
test('相邻结束与开始不视为时间冲突',()=>{assert.equal(core.overlaps([{date:'2027-03-01',title:'A',time:'08:00-09:00'},{date:'2027-03-01',title:'B',time:'09:00-10:00'}]).length,0);});
test('ICS每周次数、双周、排除日期和追加日期',()=>{
  let result=core.parseIcs(ics('RRULE:FREQ=WEEKLY;COUNT=4;BYDAY=MO\nEXDATE;TZID=Asia/Shanghai:20270308T083000\nRDATE;TZID=Asia/Shanghai:20270330T083000'),cfg);
  assert.deepEqual(result.items.map(x=>x.date),['2027-03-01','2027-03-15','2027-03-22','2027-03-30']);
  result=core.parseIcs(ics('RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3'),cfg);assert.deepEqual(result.items.map(x=>x.week),[1,3,5]);
  result=core.parseIcs(ics('RRULE:FREQ=WEEKLY;UNTIL=20270315T083000;BYDAY=MO'),cfg);assert.equal(result.items.length,3);
});
test('ICS UTC跨日转换仍遵循原时区BYDAY',()=>{
  const result=core.parseIcs(ics('RRULE:FREQ=WEEKLY;COUNT=2;BYDAY=MO','DTSTART:20270301T233000Z\nDTEND:20270302T010000Z'),cfg);
  assert.deepEqual(result.items.map(x=>[x.date,x.time]),[['2027-03-02','07:30-09:00'],['2027-03-09','07:30-09:00']]);
});
test('ICS折行及文本转义安全解析',()=>{
  const input=ics().replace('SUMMARY:课程','SUMMARY:很长的课程\n 名\\,进阶');const result=core.parseIcs(input,cfg);assert.equal(result.items[0].title,'很长的课程名,进阶');
});
test('ICS不支持的规则、调课覆盖、全天或跨日显式拒绝',()=>{
  for(const input of [ics('RRULE:FREQ=MONTHLY'),ics('RRULE:FREQ=WEEKLY;BYSETPOS=1'),ics('RECURRENCE-ID:20270301T083000'),ics('RRULE:FREQ=WEEKLY;BYDAY=TU'),ics('','DTSTART;VALUE=DATE:20270301\nDTEND;VALUE=DATE:20270302'),ics('','DTSTART;TZID=Europe/London:20270301T083000\nDTEND;TZID=Europe/London:20270301T100500'),ics('','DTSTART:20270301T233000\nDTEND:20270302T010000')])assert.throws(()=>core.parseIcs(input,cfg));
});
test('ICS COUNT从学期前的DTSTART计算，学期边界不漏算',()=>{
  const input=ics('RRULE:FREQ=WEEKLY;COUNT=3','DTSTART;TZID=Asia/Shanghai:20270222T083000\nDTEND;TZID=Asia/Shanghai:20270222T100500');
  assert.deepEqual(core.parseIcs(input,cfg).items.map(x=>x.date),['2027-03-01','2027-03-08']);
});
test('预览校验防止误改；HTML课程名不能注入脚本',()=>{
  const p=plan([rule({title:'<script>alert(1)</script>'})]);assert.doesNotMatch(core.htmlPreview(p),/<script>/);assert.match(core.htmlPreview(p),/&lt;script&gt;/);
  const changed=JSON.parse(JSON.stringify(p));changed.items[0].date='2027-03-02';assert.throws(()=>core.validatePlan(changed),/校验/);
});
test('稳定ID按账号隔离，同账号多次生成保持一致',()=>{
  const item=plan().items[0];assert.equal(core.stableId(actor,item),core.stableId(actor,{...item,place:'不同场地'}));assert.notEqual(core.stableId(actor,item),core.stableId(other,item));assert.match(core.stableId(actor,item),/^[0-9a-f]{32}$/);
});
test('语义去重兼容原来的任意ID与room字段',()=>{
  const p=plan(),old=row(p.items[0],{id:'a'.repeat(32),payload:{...p.items[0],place:'',room:'A101'}});
  const check=preflight(p,[old],actor);assert.equal(check.add.length,2);assert.equal(check.skip.length,1);assert.equal(check.conflicts.length,0);
});
test('已删除/归档课程不会被重复导入恢复；变更教室拒绝覆盖',()=>{
  const p=plan();for(const old of [row(p.items[0],{deleted_at:'2027-01-01'}),row(p.items[0],{status:'archived'})])assert.match(preflight(p,[old],actor).skip[0].reason,/不恢复/);
  const changed=row({...p.items[0],place:'B202',room:'B202'});assert.ok(preflight(p,[changed],actor).conflicts.some(x=>x.includes('不同教室')));
});
test('与已有课程重叠时阻止写入',()=>{
  const p=plan();const old=row({...p.items[0],title:'英语',time:'09:00-10:30'});
  assert.ok(preflight(p,[old],actor).conflicts.length);assert.equal(preflight(p,[old],actor,{allowOverlaps:true}).conflicts.length,0);
});
test('云端客户端只使用受控新增RPC，不做直接覆盖',async()=>{
  const requests=[];const item=plan().items[0],id=core.stableId(actor,item);
  const c=new Cloud({token:'fake-secret',fetchImpl:async(url,opts)=>{requests.push({url,opts});return new Response(JSON.stringify([{id,payload:item,status:'active',deleted_at:null}]),{status:200});}});
  await c.create(id,item);assert.equal(requests.length,1);assert.match(requests[0].url,/\/rpc\/calendar_save$/);const body=JSON.parse(requests[0].opts.body);assert.equal(body.p_expected,null);assert.equal(body.p_deleted,false);assert.equal(body.p_status,'active');assert.equal(requests[0].opts.redirect,'error');
});
test('云端分页读取完整记录',async()=>{
  let pages=0;const c=new Cloud({fetchImpl:async()=>new Response(JSON.stringify(++pages===1?Array.from({length:1000},()=>({})):[]),{status:200})});assert.equal((await c.rows()).length,1000);assert.equal(pages,2);
});
test('401令牌刷新一次，日志与异常不包含令牌',async()=>{
  let called=0;const c=new Cloud({token:'old-secret',fetchImpl:async(url,opts)=>{
    called++;if(url.includes('grant_type=refresh_token')){assert.equal(opts.headers.Authorization,undefined);return new Response(JSON.stringify({access_token:'new-secret',refresh_token:'new-refresh'}));}
    if(opts.headers.Authorization==='Bearer old-secret')return new Response('{}',{status:401});return new Response('[]');
  }});c.refresh='old-refresh';assert.deepEqual(await c.settings(),{semester_start:'2026-08-31',total_weeks:18,version:0});assert.equal(called,3);
  const errorCloud=new Cloud({fetchImpl:async()=>{throw new Error('accidental-secret');}});await assert.rejects(errorCloud.settings(),e=>!e.message.includes('accidental-secret'));
});
test('中途请求已落库但响应丢失：报告待确认，重试不重复',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'calendar-import-test-'));const p=plan(),rows=[];let count=0;
  const fake={actor,create:async(id,item)=>{rows.push(row(item,{id}));if(++count===2)throw new Error('模拟响应丢失');}};
  const result=await applyPlan({plan:p,cloud:fake,check:preflight(p,rows,actor),reportFile:path.join(dir,'first.json')});
  assert.equal(result.status,'partial');assert.equal(result.created.length,1);assert.equal(result.unconfirmed.length,1);assert.equal(rows.length,2);
  const retry=preflight(p,rows,actor);assert.equal(retry.add.length,1);assert.equal(retry.skip.length,2);
  fake.create=async(id,item)=>rows.push(row(item,{id}));
  const second=await applyPlan({plan:p,cloud:fake,check:retry,reportFile:path.join(dir,'second.json')});assert.equal(second.status,'complete');assert.equal(rows.length,3);assert.equal(preflight(p,rows,actor).add.length,0);
  assert.doesNotMatch(fs.readFileSync(path.join(dir,'first.json'),'utf8'),/password|access_token|refresh_token/);
});
test('取消导入或预检冲突不会继续写入',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'calendar-import-test-'));const p=plan();let writes=0;const fake={actor,create:async()=>writes++};
  const report=await applyPlan({plan:p,cloud:fake,check:preflight(p,[],actor),reportFile:path.join(dir,'cancel.json'),stopRequested:()=>true});assert.equal(writes,0);assert.equal(report.status,'stopped');
  await assert.rejects(applyPlan({plan:p,cloud:fake,check:{conflicts:['冲突']},reportFile:path.join(dir,'reject.json')}));assert.equal(writes,0);assert.equal(fs.existsSync(path.join(dir,'reject.json')),false);
});
