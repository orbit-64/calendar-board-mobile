#!/usr/bin/env node
'use strict';
if(require.main===module&&Number(process.versions.node.split('.')[0])<20){console.error('本工具需要Node.js 20以上。');process.exit(1);}
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const readline=require('node:readline/promises');
const {spawn}=require('node:child_process');
const core=require('./core.cjs');
const {Cloud,preflight,applyPlan}=require('./cloud.cjs');

function usage(){console.log(`课表批量导入工具 v1.0（Node.js 20以上，无需npm依赖）
  node cli.cjs wizard                         交互向导，先预览再确认
  node cli.cjs preview 课表.csv --semester 学期.json --out 输出前缀
  node cli.cjs preview 课表.json --out 输出前缀
  node cli.cjs preview 课表.ics --cloud-settings --out 输出前缀
  node cli.cjs check 预览.plan.json            仅登录预检，不写入
  node cli.cjs apply 预览.plan.json            预检后输入确认文字才新增

选项：--semester-start YYYY-MM-DD --total-weeks N（也可直接指定学期）
      --allow-overlaps（确认保留时间重叠）
      --allow-semester-mismatch（确认导入与当前云端设置不同的学期）
      --url https://项目.supabase.co --key sb_publishable_...
      --confirm-plan 校验值（自动化时替代键盘确认，仍执行全部预检）
登录：默认提示邮箱和隐藏密码；也可从环境变量CALENDAR_ACCESS_TOKEN读取临时访问令牌。
所有预览、报告和快照保存在本机。不自动上传、不覆盖旧课表、不修改学期设置。`);}
function args(values){
  const options={};const position=[];
  const boolean=new Set(['cloud-settings','allow-overlaps','allow-semester-mismatch','help']);
  const known=new Set([...boolean,'semester','semester-start','total-weeks','out','url','key','confirm-plan']);
  for(let i=0;i<values.length;i++){
    const v=values[i];if(!v.startsWith('--')){position.push(v);continue;}
    const key=v.slice(2);if(!known.has(key)||Object.hasOwn(options,key))throw new Error('未知或重复选项：'+v);
    if(boolean.has(key))options[key]=true;else {if(!values[i+1]||values[i+1].startsWith('--'))throw new Error('选项缺少值：'+v);options[key]=values[++i];}
  }
  return {position,options};
}
function read(file){if(fs.statSync(file).size>10*1024*1024)throw new Error('输入文件不能超过10MB');return fs.readFileSync(file,'utf8');}
async function question(prompt){if(!process.stdin.isTTY)throw new Error('当前没有交互终端，请在终端运行或使用文档中的自动化参数');const rl=readline.createInterface({input:process.stdin,output:process.stdout});try{return (await rl.question(prompt)).trim();}finally{rl.close();}}
async function secret(prompt){
  if(!process.stdin.isTTY||!process.stdin.setRawMode)throw new Error('当前终端不能安全隐藏密码；请使用临时令牌环境变量，不要将密码放入命令行');
  process.stdout.write(prompt);process.stdin.setRawMode(true);process.stdin.resume();process.stdin.setEncoding('utf8');
  return new Promise((resolve,reject)=>{let value='';
    function finish(error){process.stdin.off('data',onData);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');if(error)reject(error);else resolve(value);}
    function onData(chunk){for(const char of chunk){if(char==='\u0003'){finish(new Error('已取消登录'));return;}if(char==='\r'||char==='\n'){finish();return;}if(char==='\u007f'||char==='\b')value=value.slice(0,-1);else if(char>=' ')value+=char;}}
    process.stdin.on('data',onData);
  });
}
async function login(options){
  const cloud=new Cloud({url:options.url,key:options.key,token:process.env.CALENDAR_ACCESS_TOKEN||''});
  console.log('连接项目：'+cloud.url+'；密码仅发送给该项目，不写入本机文件。');
  const user=cloud.token?await cloud.user():await cloud.login(await question('日历账号邮箱：'),await secret('密码（输入时不显示）：'));
  console.log('当前账号：'+(user.email||user.id));return cloud;
}
function planFile(file){return core.validatePlan(JSON.parse(read(file)));}
function writeNew(file,content){fs.writeFileSync(file,content,{encoding:'utf8',flag:'wx',mode:0o600});}
function prefix(options){const p=path.resolve(options.out||path.join(os.homedir(),'CalendarImports','preview-'+new Date().toISOString().replace(/[:.]/g,'-')));fs.mkdirSync(path.dirname(p),{recursive:true});return p;}
async function makePreview(file,options,cloud=null){
  const ext=path.extname(file).toLowerCase();if(!['.csv','.json','.ics'].includes(ext))throw new Error('请选择CSV、JSON或ICS文件');
  const input=read(file);let embedded={};
  if(ext==='.json'){const data=JSON.parse(input.replace(/^\uFEFF/,''));if(!Array.isArray(data))embedded=data;}
  let settings=options.semester?JSON.parse(read(options.semester).replace(/^\uFEFF/,'')):embedded;
  if(options['cloud-settings']){
    if(options.semester||options['semester-start']||options['total-weeks'])throw new Error('云端学期与本机学期参数二选一');
    cloud=cloud||await login(options);const remote=await cloud.settings();
    if(embedded.semester_start&&(embedded.semester_start!==remote.semester_start||Number(embedded.total_weeks)!==remote.total_weeks))throw new Error('JSON内学期与云端不一致，请明确选择要导入的学期');
    settings={...remote,periods:embedded.periods};
  }else{
    if(options['semester-start'])settings={...settings,semester_start:options['semester-start']};
    if(options['total-weeks'])settings={...settings,total_weeks:options['total-weeks']};
    if(embedded.semester_start&&(embedded.semester_start!==settings.semester_start||Number(embedded.total_weeks)!==Number(settings.total_weeks)))throw new Error('输入JSON内学期与参数不一致，请先修改源文件');
  }
  const plan=core.createPlan(input,settings,{name:file,allowOverlaps:!!options['allow-overlaps']});
  const out=prefix(options),json=out+'.plan.json',html=out+'.html';
  if(fs.existsSync(json)||fs.existsSync(html))throw new Error('输出文件已存在，请换一个输出前缀，避免覆盖');
  writeNew(json,JSON.stringify(plan,null,2)+'\n');writeNew(html,core.htmlPreview(plan));
  console.log(`已生成${plan.items.length}节课程；重复合并${plan.duplicates_removed}条。\n预览：${html}\n导入计划：${json}\n校验值：${plan.sha256}\n本步骤没有写入云端。`);
  return {plan,json,html,cloud};
}
async function inspect(plan,cloud,options){
  const settings=await cloud.settings();
  const mismatch=settings.semester_start!==plan.semester.semester_start||Number(settings.total_weeks)!==plan.semester.total_weeks;
  console.log(`云端学期：${settings.semester_start}，${settings.total_weeks}周；导入学期：${plan.semester.semester_start}，${plan.semester.total_weeks}周。`);
  if(mismatch&&!options['allow-semester-mismatch'])throw new Error('导入学期与当前云端设置不同。请先核对；确需提前导入下一学期时加 --allow-semester-mismatch（不会改动云端学期设置）');
  const rows=await cloud.rows(),check=preflight(plan,rows,cloud.actor,{allowOverlaps:!!options['allow-overlaps']});
  console.log(`预检：新增${check.add.length}节，已有/历史跳过${check.skip.length}节，冲突${check.conflicts.length}处。`);
  for(const message of check.conflicts.slice(0,20))console.log('冲突：'+message);
  for(const message of check.warnings.slice(0,20))console.log('重叠提醒：'+message);
  if(check.conflicts.length)throw new Error('请先修正冲突后重新生成预览；没有执行写入');
  return {rows,check};
}
async function apply(file,options,cloud=null){
  const plan=planFile(file);cloud=cloud||await login(options);
  const {rows,check}=await inspect(plan,cloud,options);
  if(!check.add.length){console.log('没有需要新增的课程，本次未执行写入。');return;}
  if(options['confirm-plan']){if(options['confirm-plan']!==plan.sha256)throw new Error('确认校验值不一致，未执行写入');}
  else if(await question(`将为当前账号新增${check.add.length}节课程。确认请输入 IMPORT ${check.add.length}：`)!==`IMPORT ${check.add.length}`){console.log('已取消，未执行写入。');return;}
  const out=prefix(options),snapshot=out+'.before.json',reportFile=out+'.result.json';
  if(fs.existsSync(snapshot)||fs.existsSync(reportFile))throw new Error('导入报告已存在，请换一个输出前缀');
  writeNew(snapshot,JSON.stringify({account_id:cloud.actor,created_at:new Date().toISOString(),rows:rows.filter(r=>r.payload.type==='课程')},null,2)+'\n');
  // Exclusive lock prevents overlapping imports from this local tool. Stale locks
  // require manual review; retrying cannot silently delete another process's lock.
  const lock=path.join(os.homedir(),'.calendar-timetable-import.lock');let handle;
  try{handle=fs.openSync(lock,'wx',0o600);fs.writeFileSync(handle,JSON.stringify({pid:process.pid,plan:plan.sha256,started_at:new Date().toISOString()}));}
  catch(error){throw new Error('已有导入锁，请等待其他导入结束；若上次意外退出，确认没有运行中的导入再移除 '+lock);}
  let cancelled=false;const cancel=()=>{cancelled=true;console.log('\n正在停止；等待当前请求结束后保存报告。');};process.on('SIGINT',cancel);
  try{
    const report=await applyPlan({plan,cloud,check,reportFile,stopRequested:()=>cancelled});
    console.log(`结果：${report.status}；已新增${report.created.length}节，结果待确认${report.unconfirmed.length}节。\n报告：${reportFile}\n导入前课程快照：${snapshot}`);
    if(report.status!=='complete'){console.log('未自动回滚已新增课程。重新执行同一预览会先读取云端并跳过已存在记录。');process.exitCode=2;}
    else console.log('已写入云端。手机点击刷新，电脑下次同步或右键立即同步后可见。');
  }finally{process.off('SIGINT',cancel);fs.closeSync(handle);fs.unlinkSync(lock);}
}
function openPreview(file){const command=process.platform==='win32'?'explorer.exe':process.platform==='darwin'?'open':'xdg-open';const child=spawn(command,[file],{detached:true,stdio:'ignore'});child.on('error',()=>console.log('请手动打开HTML预览：'+file));child.unref();}
async function wizard(options){
  console.log('课表导入向导：准备好模板后再选择文件。示例是虚构课程，不是你的现有课表。');
  const file=path.resolve((await question('拖入或填写CSV/JSON/ICS文件路径：')).replace(/^"|"$/g,''));
  const useCloud=await question('使用当前账号的云端学期设置？输入 Y；下一学期可输入 N 手动填写：');
  let cloud=null;
  if(useCloud.toUpperCase()==='Y'){cloud=await login(options);options={...options,'cloud-settings':true};}
  else options={...options,'semester-start':await question('第一周周一（YYYY-MM-DD）：'),'total-weeks':await question('学期总周数：')};
  const made=await makePreview(file,options,cloud);openPreview(made.html);
  if(await question('请先核对HTML预览。继续云端预检请输入 CHECK，其他输入只保留预览：')!=='CHECK')return;
  cloud=made.cloud||await login(options);
  const current=await cloud.settings();
  if(current.semester_start!==made.plan.semester.semester_start||Number(current.total_weeks)!==made.plan.semester.total_weeks){
    console.log(`云端仍为${current.semester_start}、${current.total_weeks}周；预览为${made.plan.semester.semester_start}、${made.plan.semester.total_weeks}周。`);
    if(await question('确实提前导入其他学期请输入 NEXT-TERM（不会切换当前学期设置），否则取消：')!=='NEXT-TERM')return;
    options={...options,'allow-semester-mismatch':true};
  }
  await apply(made.json,{...options,out:undefined},cloud);
}
async function main(){
  const {position,options}=args(process.argv.slice(2));
  if(options.help||!position.length){usage();return;}
  const [command,file,...extra]=position;if(extra.length)throw new Error('参数过多；含空格的路径请加双引号');
  if(command==='wizard'){await wizard(options);return;}
  if(!file)throw new Error('请指定输入文件');
  if(command==='preview')await makePreview(file,options);
  else if(command==='check'){const cloud=await login(options);await inspect(planFile(file),cloud,options);console.log('只完成预检，没有执行写入。');}
  else if(command==='apply')await apply(file,options);
  else throw new Error('未知命令：'+command);
}
if(require.main===module)main().catch(error=>{console.error('未完成：'+error.message);process.exitCode=1;});
module.exports={args,makePreview,inspect};
