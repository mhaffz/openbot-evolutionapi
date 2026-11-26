param(
  [string]$BridgeBaseUrl = 'https://wft6ob6vqtms8bpr8ximfjow.143.95.166.177.sslip.io',
  [int]$PollSeconds = 3
)

$ErrorActionPreference = 'Stop'
$agentId = 'agent-afea4e9d-9c8b-4a0b-9b87-d84065c4c577'
$routineId = '84e81ab2-eb5d-43a9-916f-8c20caa489a4'
$automationDir = Join-Path $env:APPDATA 'OpenBot\automation'
$secretPath = Join-Path $env:APPDATA "OpenBot\agent-api-keys\.vault\$agentId\WEBHOOK_SECRET_1AFCC45016544CD395E12A869B2B0F5E"
$logPath = Join-Path $env:APPDATA 'OpenBot\logs\evolution-local-queue-worker.log'
$mutex = [Threading.Mutex]::new($false, 'Local\OpenBotEvolutionLocalQueueWorker')

function Write-SafeLog([string]$Message) {
  $line = "{0} {1}" -f [DateTimeOffset]::Now.ToString('o'), $Message
  Add-Content -LiteralPath $logPath -Value $line -Encoding utf8
}

function Get-Prop($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function First-Text($Message, [string[]]$Paths) {
  foreach ($path in $Paths) {
    $value = $Message
    foreach ($part in $path.Split('.')) { $value = Get-Prop $value $part }
    if ($value -is [string] -and -not [string]::IsNullOrWhiteSpace($value)) { return $value }
  }
  return ''
}

function New-CompactEvent($QueuedEvent) {
  $source = Get-Prop $QueuedEvent 'event'
  $data = Get-Prop $source 'data'
  $key = Get-Prop $data 'key'
  if ($null -eq $key) { return $null }

  $remoteJid = [string](Get-Prop $key 'remoteJid')
  $fromMe = [bool](Get-Prop $key 'fromMe')
  if ($fromMe -or $remoteJid.EndsWith('@g.us', [StringComparison]::OrdinalIgnoreCase) -or $remoteJid -eq 'status@broadcast') {
    return @{ skip = $true }
  }

  $message = Get-Prop $data 'message'
  $text = First-Text $message @(
    'conversation',
    'extendedTextMessage.text',
    'imageMessage.caption',
    'videoMessage.caption',
    'documentMessage.caption',
    'buttonsResponseMessage.selectedDisplayText',
    'templateButtonReplyMessage.selectedDisplayText',
    'listResponseMessage.title',
    'interactiveResponseMessage.body.text'
  )
  if ($text.Length -gt 2800) { $text = $text.Substring(0, 2800) + ' [texto truncado]' }

  $messageType = [string](Get-Prop $data 'messageType')
  $compactMessage = [ordered]@{}
  if ($messageType -eq 'conversation' -and $text) {
    $compactMessage.conversation = $text
  } elseif ($messageType -eq 'extendedTextMessage' -and $text) {
    $compactMessage.extendedTextMessage = @{ text = $text }
  } elseif ($messageType -eq 'imageMessage') {
    $compactMessage.imageMessage = @{ caption = $text }
  } elseif ($messageType -eq 'videoMessage') {
    $compactMessage.videoMessage = @{ caption = $text }
  } elseif ($messageType -eq 'documentMessage') {
    $compactMessage.documentMessage = @{ caption = $text }
  } elseif ($text) {
    $compactMessage.conversation = $text
  }

  $compactData = [ordered]@{
    key = [ordered]@{
      id = [string](Get-Prop $key 'id')
      remoteJid = $remoteJid
      fromMe = $false
    }
    pushName = [string](Get-Prop $data 'pushName')
    messageType = $messageType
    messageTimestamp = Get-Prop $data 'messageTimestamp'
    message = $compactMessage
  }

  return [ordered]@{
    type = 'MESSAGES_UPSERT'
    occurredAt = [DateTimeOffset]::UtcNow.ToString('o')
    data = [ordered]@{
      event = 'messages.upsert'
      instance = [string](Get-Prop $source 'instance')
      data = $compactData
    }
  }
}

if (-not $mutex.WaitOne(0)) { exit 0 }
try {
  Write-SafeLog 'worker started'
  while ($true) {
    try {
      $automationUrlFile = Join-Path $automationDir 'url'
      $automationTokenFile = Join-Path $automationDir 'token'
      if (-not (Test-Path $automationUrlFile) -or -not (Test-Path $automationTokenFile) -or -not (Test-Path $secretPath)) {
        Start-Sleep -Seconds 5
        continue
      }

      $automationUrl = (Get-Content -Raw -LiteralPath $automationUrlFile).Trim().TrimEnd('/')
      $automationToken = (Get-Content -Raw -LiteralPath $automationTokenFile).Trim()
      $sharedSecret = (Get-Content -Raw -LiteralPath $secretPath).Trim()
      $hmac = [Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($sharedSecret))
      try {
        $queueToken = [BitConverter]::ToString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes('openbot-evolution-local-queue-v1'))).Replace('-', '').ToLowerInvariant()
      } finally { $hmac.Dispose() }

      $queueHeaders = @{ Authorization = "Bearer $queueToken" }
      $localHeaders = @{ Authorization = "Bearer $automationToken" }
      $next = Invoke-RestMethod -Method Get -Uri "$($BridgeBaseUrl.TrimEnd('/'))/queue/next" -Headers $queueHeaders -TimeoutSec 15
      $queued = Get-Prop $next 'event'
      if ($null -eq $queued) { Start-Sleep -Seconds $PollSeconds; continue }

      $eventId = [string](Get-Prop $queued 'id')
      $payloadObject = New-CompactEvent $queued
      if ($null -eq $payloadObject) {
        Write-SafeLog "discarded malformed event id=$eventId"
      } elseif ($payloadObject.skip) {
        Write-SafeLog "ignored own/group/status event id=$eventId"
      } else {
        $payload = ConvertTo-Json -InputObject $payloadObject -Depth 20 -Compress
        $runBody = ConvertTo-Json -InputObject @{ payload = $payload } -Depth 5 -Compress
        $runUri = "$automationUrl/v1/agents/$agentId/routines/$routineId/run"
        $run = Invoke-RestMethod -Method Post -Uri $runUri -Headers $localHeaders -ContentType 'application/json' -Body $runBody -TimeoutSec 20
        Write-SafeLog "OpenBot accepted event id=$eventId"
      }

      $ackBody = ConvertTo-Json -InputObject @{ id = $eventId } -Compress
      Invoke-RestMethod -Method Post -Uri "$($BridgeBaseUrl.TrimEnd('/'))/queue/ack" -Headers $queueHeaders -ContentType 'application/json' -Body $ackBody -TimeoutSec 15 | Out-Null
      $sharedSecret = $null
      $automationToken = $null
      $queueToken = $null
      Start-Sleep -Milliseconds 300
    } catch {
      $statusCode = $null
      if ($_.Exception.Response -and $_.Exception.Response.StatusCode) { $statusCode = [int]$_.Exception.Response.StatusCode }
      if ($statusCode) { Write-SafeLog "worker request failed http=$statusCode; event will retry" }
      else { Write-SafeLog 'worker request failed; event will retry' }
      Start-Sleep -Seconds 10
    }
  }
} finally {
  Write-SafeLog 'worker stopped'
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
