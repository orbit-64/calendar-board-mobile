param([Parameter(ValueFromRemainingArguments=$true)][string[]]$ImportArguments)
$ErrorActionPreference='Stop'
$nodeCommand=Get-Command node -ErrorAction SilentlyContinue
$nodePath=if($nodeCommand){$nodeCommand.Source}else{Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'}
if(-not(Test-Path -LiteralPath $nodePath)){throw '未找到Node.js，请安装Node.js 20以上；也可将本工具发给有Node.js的电脑运行。'}
$resources=Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Rainmeter/Skins/CalendarBoard/@Resources'
$api=Join-Path $resources 'SupabaseApi.ps1'
if(-not(Test-Path -LiteralPath $api)){throw '未找到已连接的电脑日历。请改用 node cli.cjs wizard，使用邮箱登录。'}
. $api
$config=Read-SyncConfig
$previous=$env:CALENDAR_ACCESS_TOKEN
try {
    $env:CALENDAR_ACCESS_TOKEN=Get-SyncAccessToken
    $cli=Join-Path $PSScriptRoot 'cli.cjs'
    if(-not $ImportArguments){$ImportArguments=@('wizard')}
    & $nodePath $cli @ImportArguments --url ([string]$config.url) --key ([string]$config.key)
    if($LASTEXITCODE){throw '导入工具未完成，请查看上方提示与本机报告。'}
} finally {
    $env:CALENDAR_ACCESS_TOKEN=$previous
}
