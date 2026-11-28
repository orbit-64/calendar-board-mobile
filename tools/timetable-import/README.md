# 课表批量导入工具 v1.0

先展开预览，再登录预检，最后确认新增。同一份课表反复执行会跳过已存在的课程，不覆盖现有内容。工具是电脑上的独立程序，不是 APK 内的按钮；Windows、macOS、Linux 有 Node.js 20 以上即可运行，无需 npm 安装依赖。

**你已经导入的大一上课表不用重新导入。本目录的模板都是虚构示例，不是你的真实课表。**

## Windows 最容易的用法

1. 复制 `templates/courses.csv`（按时间填写）或 `courses-periods.csv`（按节次填写），改成自己的课表。也可以使用 JSON、教务系统导出的 ICS。
2. 双击 `启动向导.cmd`，填写课表文件路径。它会复用电脑日历已经连接的账号，不把登录令牌写进课表、预览或报告。此脚本需要在日常登录 Windows 的用户会话运行。
3. 选择使用当前云端学期，或者手动填写下一学期的第一周周一、总周数。
4. 工具生成并打开 HTML 预览：检查第一天、最后一天、单双周、课程时间和教室。默认输出到用户目录 `CalendarImports`。
5. 核对后输入 `CHECK` 进行云端预检。工具显示当前账号及新增、跳过、冲突数量。
6. 真正写入前还需输入 `IMPORT 数量`，例如 `IMPORT 280`。任何其他输入都会取消写入。

尚未连接电脑日历、使用 Mac 或没有找到 Node.js 时，安装 Node.js 20 以上，在本目录终端执行：

```sh
node cli.cjs wizard
```

它会提示日历账号邮箱和密码，密码输入时不显示，仅发往显示的 Supabase 项目，不保存。不要把密码发给他人或填写到命令行参数。

## 模板字段

| 字段 | 含义 |
|---|---|
| title / 课程名 | 课程完整名称 |
| weekday / 星期 | 周一为1，周日为7；也接受“周一”等中文 |
| start_time、end_time / 开始时间、结束时间 | `08:30`、`10:05`，结束必须晚于开始 |
| start_period、end_period / 起始节、结束节 | 与时间字段二选一，例如1至2节 |
| start_week、end_week / 起始周、结束周 | 包含起止周，范围不超过学期总周数 |
| weeks / 指定周次 | 如 `3-6;9;12-14`，与起止周二选一 |
| week_pattern / 单双周 | `all` / `odd` / `even`，或每周／单周／双周；单双按学期周次计算 |
| place / 教室 | 可留空 |

节次默认沿用现有学校时间表，1～2节为08:30～10:05，3～4节10:20～11:55等。**换学校请在 `semester.json` 的 periods 中修改，不要直接套用。** CSV建议保存成UTF-8（带不带BOM均可）。含逗号或双引号的课程名用标准CSV引号包围。JSON示例可直接携带学期和自定义节次表。

## 命令行用法

以下命令默认只生成本机预览，不登录、不写云端：

```sh
node cli.cjs preview templates/courses.csv --semester templates/semester.json --out preview/example
node cli.cjs preview templates/courses.json --out preview/json-example
node cli.cjs preview templates/courses.ics --semester templates/semester.json --out preview/ics-example
```

使用账号当前的云端学期生成预览（只读取）：

```sh
node cli.cjs preview 我的课表.csv --cloud-settings --out preview/my-term
```

只有以下 apply 命令在全部预检通过并输入确认文字后才写云端：

```sh
node cli.cjs check preview/my-term.plan.json
node cli.cjs apply preview/my-term.plan.json
```

所有命令的输入输出路径含空格时加双引号。输出已存在时会拒绝覆盖，换一个 `--out` 前缀即可。

提前导入下一学期时，云端仍可能是本学期设置。默认会阻止这个不一致，确认日期正确后可加 `--allow-semester-mismatch`，它不会修改云端学期配置。正式开学时，再在 APK 设置中切换学期。

如果确实允许两门课时间重叠，预览和 apply 都要显式加 `--allow-overlaps`；HTML和预检仍会保留重叠提醒。同一课程重复却填写不同教室的情况始终需要人工核对。

自动化可以用 `--confirm-plan 完整校验值` 替代键盘确认，校验值必须对应这一份预览；所有日期、冲突与账号检查仍然执行。账号临时访问令牌可经 `CALENDAR_ACCESS_TOKEN` 环境变量传入，工具不会持久化该令牌。Windows已连接账号脚本同样通过子进程环境临时传递访问令牌，执行结束恢复原环境。

## ICS 支持范围

- 支持具体事件，及 `FREQ=WEEKLY` 的 `INTERVAL`、`COUNT`或`UNTIL`、`BYDAY`，周起点为周一。
- 支持 `EXDATE` 排除和 `RDATE` 追加，处理折行和文本转义。
- 支持北京时间（Asia/Shanghai、Asia/Chongqing、Asia/Hong_Kong）、UTC/Z，以及没有时区标记的浮动时间（按北京时间处理）。
- 仅保留所选学期内的课程。首次日期早于学期时，COUNT仍从原始首次日期计算。
- 全天、跨午夜、秒级课程，以及月循环、其他时区、RECURRENCE-ID单次调课覆盖、DURATION等暂不支持，会明确报错。请让教务系统导出“展开后的具体事件”，或转换成CSV。工具不会猜测规则后悄悄漏掉课程。

## 重复、冲突和失败恢复

- 同一日期、起止时间、规范化课程名为同一节课；同账号生成稳定ID，不同账号的ID不同。
- 也识别原来导入的任意ID课程，以及原来的room教室字段。
- 云端已经存在的相同课程跳过。已归档或手动删除的同一节课也跳过，不会被批量导入恢复。
- 已有有效课程的教室与导入内容不一致时停止，保留原记录。不会覆盖教师、课程名、教室或其他事项。
- 只通过现有受控接口 `calendar_save` 新增（`p_expected=null`），不直接更新或删除任何记录。所有写入继续受登录账号及云端所有权检查保护。
- 导入前保存当前账号的**课程**快照 `.before.json`，过程中每条保存进度到 `.result.json`。它们是本机私有文件，可能包含课程安排，不要上传到公开仓库。
- 整个批次不是单一数据库事务；网络失败可能已经完成一部分。工具会停止后续写入并标记“待确认”。重新执行**同一份**计划，先读取云端并跳过已存在课程，避免重放；不会自动删除已成功新增的课程。
- Ctrl+C会在当前请求结束后停止并保存进度。异常断电留下用户目录 `.calendar-timetable-import.lock` 时，确认没有运行中的导入进程后再手工移除该锁。
- 工具不调整同步周期、不修改日历学期设置、不调用自动顺延或清理，也不进行OCR或自动假期调课。学校特殊停课／调课需要在原始规则或导入后单独核对。

## 测试

```sh
node --test tests/import.test.cjs
```

测试使用虚构规则、隔离临时目录和模拟云端响应，包含单双周、指定周次、节次转换、CSV、ICS、跨年、UTC跨日、去重、冲突、结果丢失后重试及取消。没有向用户真实课表写入测试课程。
