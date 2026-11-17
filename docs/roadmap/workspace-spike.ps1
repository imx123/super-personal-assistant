<#
.SYNOPSIS
  P3-4 workspace isolation spike for Superagent (branch `next`, baseline HEAD 3dfbf4a).

.DESCRIPTION
  A controlled, Git-only experiment about worker isolation. The script creates ONE new directory
  under .artifacts and keeps every byte it creates, so a reviewer can re-read the evidence
  without re-running anything.

  Experiments
    E0  a synthetic "project repository" - the shared workspace a Project uses today
    E1  two workers change different files in that shared directory
    E2  two workers change the same file in that shared directory (silent overwrite)
    E3  two workers change the same file in two isolated worktrees (detectable conflict)
    E4  one worker fails; the failure stays inside its own directory (local cleanup)
    E5  per-Assignment diffs, one per isolated worktree
    E6  the node's repository guard (src/node/review-diff.ts) mirrored against every layout
    E7  a sequential-snapshot probe: what a per-Assignment baseline would cost

  Rules this script keeps
    * nothing outside the run directory is written, moved or deleted
    * no `reset --hard`, no `git clean`, no recursive delete (audited at the end, check C19)
    * no network, no model, no global identity: every commit carries
      `git -c user.name=... -c user.email=...`
    * only desensitized synthetic files
    * the Git environment is scrubbed the way src/node/review-diff.ts scrubs it

  Exit code
    0  every recorded check matched its expectation
    1  at least one check did not (see checks.md and evidence.json)
    2  Git was not available, so nothing could be measured
#>
[CmdletBinding()]
param(
    # Where the unique run directory is created. Default: .artifacts/phase3-workspace under this repo.
    [string] $BaseDir = '',
    # The Git program to run.
    [string] $GitCommand = 'git',
    # How long one Git command may take.
    [int] $GitTimeoutMs = 120000
)

$ErrorActionPreference = 'Stop'

# ----------------------------------------------------------------- state ------
$script:Checks = @()
$script:Commands = @()
$script:Observations = [ordered]@{}
$script:GitOptions = @(
    '-c', 'user.name=Superagent Spike',
    '-c', 'user.email=spike@example.invalid',
    '-c', 'commit.gpgsign=false',
    '-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=false',
    '-c', 'init.defaultBranch=main',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.pager=cat',
    '-c', 'color.ui=false',
    '-c', 'advice.detachedHead=false'
)
$script:EnvNames = @(
    'PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR'
)
# The configuration keys the node's review refuses, mirrored from src/node/review-diff.ts.
$script:RefusedExact = @(
    'core.attributesfile', 'core.excludesfile', 'core.hookspath', 'core.worktree',
    'core.sshcommand', 'core.gitproxy', 'core.askpass', 'core.editor', 'core.sequenceeditor',
    'core.credentialhelper', 'diff.external', 'diff.orderfile', 'gpg.program', 'gpg.ssh.program',
    'include.path'
)
$script:RefusedFamilies = @('alias.', 'credential.', 'filter.', 'includeif.')
$script:RefusedDrivers = @('.command', '.textconv')

# ---------------------------------------------------------------- helpers -----
function New-Dir {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { [void](New-Item -ItemType Directory -Path $Path -Force) }
    return $Path
}

function Write-LfFile {
    param([string] $Path, [string] $Text)
    if ($null -eq $Text) { $Text = '' }
    $normalized = $Text.Replace("`r`n", "`n")
    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path -LiteralPath $parent)) { [void](New-Item -ItemType Directory -Path $parent -Force) }
    [System.IO.File]::WriteAllText($Path, $normalized, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-TextSha256 {
    param([string] $Text)
    if ($null -eq $Text) { $Text = '' }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
}

function Quote-Arg {
    param([string] $Value)
    if ($null -eq $Value) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    $slashes = 0
    foreach ($ch in $Value.ToCharArray()) {
        if ($ch -eq [char] 92) { $slashes++; continue }
        if ($ch -eq [char] 34) {
            [void]$sb.Append(('\' * ($slashes * 2 + 1)))
            [void]$sb.Append('"')
            $slashes = 0
            continue
        }
        if ($slashes -gt 0) { [void]$sb.Append(('\' * $slashes)); $slashes = 0 }
        [void]$sb.Append($ch)
    }
    if ($slashes -gt 0) { [void]$sb.Append(('\' * ($slashes * 2))) }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function Invoke-Git {
    param(
        [string] $Dir = '',
        [string[]] $GitArgs = @(),
        [string] $Label = 'git'
    )
    $full = @()
    if ($Dir) { $full += @('-C', $Dir) }
    $full += $script:GitOptions
    $full += $GitArgs
    $commandLine = 'git ' + (($full | ForEach-Object { Quote-Arg $_ }) -join ' ')
    $script:Commands += $commandLine

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $script:GitPath
    $psi.Arguments = (($full | ForEach-Object { Quote-Arg $_ }) -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $script:RunDir
    $psi.EnvironmentVariables.Clear()
    foreach ($name in $script:EnvNames) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        if ($null -ne $value) { $psi.EnvironmentVariables[$name] = $value }
    }
    $psi.EnvironmentVariables['GIT_CONFIG_NOSYSTEM'] = '1'
    $psi.EnvironmentVariables['GIT_CONFIG_GLOBAL'] = Join-Path $script:RunDir 'env\empty.gitconfig'
    $psi.EnvironmentVariables['GIT_ATTR_NOSYSTEM'] = '1'
    $psi.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
    $psi.EnvironmentVariables['GIT_PAGER'] = 'cat'
    $psi.EnvironmentVariables['LC_ALL'] = 'C'

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()
    $exited = $proc.WaitForExit($script:GitTimeoutMs)
    if (-not $exited) { try { $proc.Kill() } catch { } }
    $stdout = ''
    $stderr = ''
    try { $stdout = $stdoutTask.Result } catch { $stdout = '' }
    try { $stderr = $stderrTask.Result } catch { $stderr = '' }
    $code = 124
    if ($exited) { $code = $proc.ExitCode }
    $proc.Dispose()

    $safeLabel = ($Label -replace '[^A-Za-z0-9._-]', '_')
    Write-LfFile (Join-Path $script:LogDir "$safeLabel.out.txt") $stdout
    Write-LfFile (Join-Path $script:LogDir "$safeLabel.err.txt") $stderr
    $transcript = @(
        "### $Label",
        "`$ $commandLine",
        "[exit] $code",
        '--- stdout ---',
        $stdout,
        '--- stderr ---',
        $stderr,
        ''
    ) -join "`n"
    Add-Content -LiteralPath $script:TranscriptPath -Value $transcript -Encoding UTF8

    return [pscustomobject]@{
        Command  = $commandLine
        Code     = $code
        Stdout   = $stdout
        Stderr   = $stderr
        Text     = ($stdout + $stderr)
        Label    = $Label
    }
}

function Add-Check {
    param(
        [string] $Id,
        [string] $Title,
        [string] $Expectation,
        [string] $Observed,
        [bool] $Ok
    )
    $script:Checks += [pscustomobject]@{
        id = $Id; title = $Title; expectation = $Expectation; observed = $Observed; ok = $Ok
    }
    $mark = 'PASS'
    if (-not $Ok) { $mark = 'FAIL' }
    $flatObserved = ($Observed -replace "`r`n", ' ' -replace "`n", ' | ')
    $flatExpected = ($Expectation -replace "`r`n", ' ' -replace "`n", ' | ')
    Add-Content -LiteralPath $script:ChecksPath -Value ("- [$mark] $Id $Title -- expected: $flatExpected -- observed: $flatObserved") -Encoding UTF8
    Write-Host ("[{0}] {1} {2}" -f $mark, $Id, $Title)
}

function Add-Finding {
    param([string] $Title, [string[]] $Lines)
    Add-Content -LiteralPath $script:FindingsPath -Value ("`n## $Title`n") -Encoding UTF8
    foreach ($line in $Lines) { Add-Content -LiteralPath $script:FindingsPath -Value $line -Encoding UTF8 }
}

function Get-Names {
    param([string] $Text)
    if ($null -eq $Text) { return @() }
    $names = @()
    foreach ($line in ($Text -split "`n")) {
        $clean = $line.Trim()
        if ($clean -ne '') { $names += $clean }
    }
    return $names
}

function Get-ConfigKeys {
    param([string] $Text)
    if ($null -eq $Text) { return @() }
    $keys = @()
    $section = ''
    foreach ($raw in ($Text -split "`n")) {
        $line = $raw.Trim()
        if ($line -eq '' -or $line.StartsWith('#') -or $line.StartsWith(';')) { continue }
        if ($line.StartsWith('[')) {
            $end = $line.IndexOf(']')
            if ($end -lt 0) { continue }
            $section = ($line.Substring(1, $end - 1).Trim().ToLowerInvariant()) -replace '\s+', ''
            continue
        }
        $equals = $line.IndexOf('=')
        if ($equals -lt 0) { $name = $line } else { $name = $line.Substring(0, $equals) }
        $name = $name.Trim().ToLowerInvariant()
        if ($name -eq '') { continue }
        if ($section -eq '') { $keys += $name } else { $keys += ($section + '.' + $name) }
    }
    return $keys
}

function Get-RefusedConfigLabel {
    param([string] $Key)
    if ($script:RefusedExact -contains $Key) { return $Key }
    foreach ($prefix in $script:RefusedFamilies) { if ($Key.StartsWith($prefix)) { return $prefix } }
    if ($Key.StartsWith('diff.')) {
        foreach ($suffix in $script:RefusedDrivers) { if ($Key.EndsWith($suffix)) { return $suffix } }
    }
    return $null
}

function Test-ReviewGuard {
    <#
      A mirror of guardRepository() in src/node/review-diff.ts. It is a simplified mirror:
      it does not resolve symlinks or junctions the way realpathSync.native does, and it does
      not read config.worktree inside a linked worktree. The production guard is the authority.
    #>
    param([string] $Dir)
    $dotGit = Join-Path $Dir '.git'
    if (-not (Test-Path -LiteralPath $dotGit)) {
        return [pscustomobject]@{ ok = $false; reason = 'The workspace holds no Git directory of its own' }
    }
    $item = Get-Item -LiteralPath $dotGit -Force
    if (-not $item.PSIsContainer) {
        return [pscustomobject]@{ ok = $false; reason = "The workspace's .git points at another repository (linked worktree or submodule)" }
    }
    $gitDir = $item.FullName
    if (Test-Path -LiteralPath (Join-Path $gitDir 'commondir')) {
        return [pscustomobject]@{ ok = $false; reason = 'The workspace is a linked worktree of another repository' }
    }
    $objects = Join-Path $gitDir 'objects'
    if (Test-Path -LiteralPath $objects) {
        $alternates = Join-Path (Join-Path $objects 'info') 'alternates'
        if (Test-Path -LiteralPath $alternates) {
            $text = Get-Content -LiteralPath $alternates -Raw
            if ($null -eq $text) { $text = '' }
            if ($text.Trim() -ne '') {
                return [pscustomobject]@{ ok = $false; reason = 'The repository borrows its objects from another repository' }
            }
        }
    }
    foreach ($name in @('config', 'config.worktree')) {
        $path = Join-Path $gitDir $name
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $text = Get-Content -LiteralPath $path -Raw
        foreach ($key in (Get-ConfigKeys $text)) {
            $label = Get-RefusedConfigLabel $key
            if ($null -ne $label) {
                return [pscustomobject]@{ ok = $false; reason = "The repository's own configuration declares a refused key: $label" }
            }
        }
    }
    return [pscustomobject]@{ ok = $true; reason = 'The repository is its own' }
}

function Get-AlphaContent { param([int] $Value) return "export const alpha = {`n  value: $Value,`n}`n" }
function Get-BetaContent { param([int] $Value) return "export const beta = {`n  value: $Value,`n}`n" }
function Get-SharedContent { param([string] $Note) return "export const shared = {`n  note: '$Note',`n}`n" }

# ------------------------------------------------------------ run directory ---
$scriptRoot = $PSScriptRoot
if ([string]::IsNullOrEmpty($scriptRoot)) { $scriptRoot = (Get-Location).Path }
$base = if ([string]::IsNullOrEmpty($BaseDir)) { Join-Path $scriptRoot '../../.artifacts/phase3-workspace' } else { $BaseDir }
$base = [IO.Path]::GetFullPath($base)
[void](New-Item -ItemType Directory -Path $base -Force)

$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$suffix = ([guid]::NewGuid().ToString('N')).Substring(0, 6)
$script:RunDir = Join-Path $base "spike-$stamp-$suffix"
[void](New-Item -ItemType Directory -Path $script:RunDir -Force)
$script:LogDir = New-Dir (Join-Path $script:RunDir 'logs')
$script:TranscriptPath = Join-Path $script:RunDir 'git-transcript.log'
$script:ChecksPath = Join-Path $script:RunDir 'checks.md'
$script:FindingsPath = Join-Path $script:RunDir 'findings.md'
Write-LfFile $script:TranscriptPath ''
Write-LfFile $script:ChecksPath '# P3-4 workspace spike - checks'
Write-LfFile $script:FindingsPath '# P3-4 workspace spike - findings'

# The Git program. Nothing runs without it.
$gitCommandInfo = Get-Command $GitCommand -ErrorAction SilentlyContinue
if ($null -eq $gitCommandInfo) {
    Write-LfFile (Join-Path $script:RunDir 'ERROR.txt') "Git was not found on PATH, so no experiment could be measured."
    Write-Host "Git was not found. See $script:RunDir\ERROR.txt"
    exit 2
}
$script:GitPath = $gitCommandInfo.Source

# The scrubbed Git environment, the way src/node/review-diff.ts builds it.
$envDir = New-Dir (Join-Path $script:RunDir 'env')
Write-LfFile (Join-Path $envDir 'empty.gitconfig') ''

$gitVersion = (Invoke-Git '' @('version') 'git-version').Stdout.Trim()
$psVersion = $PSVersionTable.PSVersion.ToString()
Write-Host "Run directory: $script:RunDir"
Write-Host "Git: $gitVersion"

Write-LfFile (Join-Path $script:RunDir 'README.txt') @"
P3-4 workspace isolation spike - Superagent (branch next, baseline HEAD 3dfbf4a)

Run directory : $script:RunDir
Git           : $gitVersion
PowerShell    : $psVersion

Layout
  repo\              the shared workspace a Project uses today: one Git repository, several workers
  worktrees\         linked worktrees of repo\, one per simulated Assignment
  clones\            independent copies of repo\ (plain clone, shared clone, clone with a refused config key)
  probe-seq\         a second repository used by the sequential-snapshot probe (E7)
  env\               HOME / USERPROFILE of the scrubbed Git environment (empty)
  logs\              stdout and stderr of every Git command
  git-transcript.log every Git command, its exit code and its output
  checks.md          every check with its expectation and what was measured
  findings.md        the readable digest
  evidence.json      the machine-readable digest

Nothing outside this directory was written, moved or deleted. No reset --hard, no git clean,
no recursive delete. No network, no model, no global Git identity.
"@

# ------------------------------------------------------------------- E0 -------
$repo = New-Dir (Join-Path $script:RunDir 'repo')
$init = Invoke-Git $repo @('init') 'e00-init'
$alphaPath = Join-Path $repo 'src\alpha.ts'
$betaPath = Join-Path $repo 'src\beta.ts'
$sharedPath = Join-Path $repo 'src\shared.ts'
$notesPath = Join-Path $repo 'docs\notes.md'
Write-LfFile $alphaPath (Get-AlphaContent 1)
Write-LfFile $betaPath (Get-BetaContent 2)
Write-LfFile $sharedPath (Get-SharedContent 'baseline')
Write-LfFile $notesPath "# Spike fixture`nSynthetic content for the P3-4 workspace isolation spike.`n"
[void](Invoke-Git $repo @('add', '-A') 'e01-add')
$commit = Invoke-Git $repo @('commit', '-m', 'spike: baseline fixture') 'e02-commit'
$base = (Invoke-Git $repo @('rev-parse', 'HEAD') 'e03-head').Stdout.Trim()
$toplevel = (Invoke-Git $repo @('rev-parse', '--show-toplevel') 'e04-toplevel').Stdout.Trim()
Add-Check -Id 'C1' -Title 'a project repository exists with one baseline commit' `
    -Expectation 'git init succeeds, one commit exists, HEAD resolves' `
    -Observed ("init=$($init.Code) commit=$($commit.Code) HEAD=$base") `
    -Ok (($init.Code -eq 0) -and ($commit.Code -eq 0) -and ($base -match '^[0-9a-f]{40}$'))

# ------------------------------------------------------------------- E1 -------
# Two workers in the shared directory change different files. The worker is simulated by an
# ordinary file write into the session's working directory - the same operation the write/edit
# tool of a DSH session performs.
Write-LfFile $alphaPath (Get-AlphaContent 11)
Write-LfFile $betaPath (Get-BetaContent 22)

# The exact read the node performs for a review (src/node/review-diff.ts readDiff).
$e1Diff = Invoke-Git $repo @('diff', '--no-ext-diff', '--no-textconv', '--no-color', $base, '--') 'e10-review-diff'
$e1Names = Invoke-Git $repo @('diff', '--name-only', $base, '--') 'e11-review-names'
$e1Untracked = Invoke-Git $repo @('ls-files', '--others', '--exclude-standard') 'e12-review-untracked'
$e1Whitespace = Invoke-Git $repo @('diff', '--no-color', '--check', $base, '--') 'e13-review-whitespace'
$e1Log = Invoke-Git $repo @('log', '--oneline', ($base + '..HEAD')) 'e14-review-log'
$e1Snapshot = Invoke-Git $repo @('stash', 'create') 'e15-shared-snapshot'
$snapshotOid = $e1Snapshot.Stdout.Trim()
$e1SnapshotNames = @()
if ($snapshotOid -match '^[0-9a-f]{40}$') {
    $e1SnapshotNames = @(Get-Names (Invoke-Git $repo @('diff', '--name-only', $base, $snapshotOid, '--') 'e16-snapshot-names').Stdout)
}
$e1NameList = @(Get-Names $e1Names.Stdout)

Add-Check -Id 'C2' -Title 'the review diff shows changes from both workers' `
    -Expectation 'the node read lists src\alpha.ts and src\beta.ts' `
    -Observed ("files=" + ($e1NameList -join ', ')) `
    -Ok (($e1NameList -contains 'src/alpha.ts') -and ($e1NameList -contains 'src/beta.ts'))
Add-Check -Id 'C3' -Title 'the shared workspace holds no authorship of its own' `
    -Expectation 'no commit exists after the baseline, so the diff names no writer' `
    -Observed ("git log " + ($base + '..HEAD') + " = '" + $e1Log.Stdout.Trim() + "'") `
    -Ok ($e1Log.Stdout.Trim() -eq '')
$snapshotLabel = $snapshotOid
if ($snapshotLabel.Length -gt 8) { $snapshotLabel = $snapshotLabel.Substring(0, 8) }
Add-Check -Id 'C4' -Title 'one snapshot of a shared directory cannot attribute a change' `
    -Expectation 'a single tree snapshot taken after both workers still lists both files' `
    -Observed ("snapshot=" + $snapshotLabel + " files=" + ($e1SnapshotNames -join ', ')) `
    -Ok (($e1SnapshotNames -contains 'src/alpha.ts') -and ($e1SnapshotNames -contains 'src/beta.ts'))
Add-Check -Id 'C5' -Title 'the review answer is complete and whitespace-clean for these edits' `
    -Expectation 'untracked list empty, whitespace check finds nothing' `
    -Observed ("untracked=" + $e1Untracked.Stdout.Trim() + " whitespace=" + $e1Whitespace.Stdout.Trim()) `
    -Ok (($e1Untracked.Stdout.Trim() -eq '') -and ($e1Whitespace.Stdout.Trim() -eq ''))

# ------------------------------------------------------------------- E7 -------
# What a per-Assignment baseline would cost: a tree snapshot at every Assignment boundary.
$seq = New-Dir (Join-Path $script:RunDir 'probe-seq')
[void](Invoke-Git $seq @('init') 'e70-init')
Write-LfFile (Join-Path $seq 'src\alpha.ts') (Get-AlphaContent 1)
Write-LfFile (Join-Path $seq 'src\beta.ts') (Get-BetaContent 2)
Write-LfFile (Join-Path $seq 'src\shared.ts') (Get-SharedContent 'baseline')
[void](Invoke-Git $seq @('add', '-A') 'e71-add')
[void](Invoke-Git $seq @('commit', '-m', 'spike: baseline fixture') 'e72-commit')
$seqBase = (Invoke-Git $seq @('rev-parse', 'HEAD') 'e73-head').Stdout.Trim()
Write-LfFile (Join-Path $seq 'src\alpha.ts') (Get-AlphaContent 11)
$snapA = (Invoke-Git $seq @('stash', 'create') 'e74-snapshot-a').Stdout.Trim()
Write-LfFile (Join-Path $seq 'src\beta.ts') (Get-BetaContent 22)
$snapB = (Invoke-Git $seq @('stash', 'create') 'e75-snapshot-b').Stdout.Trim()
$seqBetweenA = @()
$seqBetweenB = @()
if ($snapA -match '^[0-9a-f]{40}$') {
    $seqBetweenA = @(Get-Names (Invoke-Git $seq @('diff', '--name-only', $seqBase, $snapA, '--') 'e76-diff-base-a').Stdout)
}
if ($snapA -match '^[0-9a-f]{40}$' -and $snapB -match '^[0-9a-f]{40}$') {
    $seqBetweenB = @(Get-Names (Invoke-Git $seq @('diff', '--name-only', $snapA, $snapB, '--') 'e77-diff-a-b').Stdout)
}
Add-Check -Id 'C6' -Title 'a snapshot per Assignment boundary attributes the change' `
    -Expectation 'the window of worker A names only src\alpha.ts, the window of worker B only src\beta.ts' `
    -Observed ("A=" + ($seqBetweenA -join ', ') + " B=" + ($seqBetweenB -join ', ')) `
    -Ok ((($seqBetweenA -join ',') -eq 'src/alpha.ts') -and (($seqBetweenB -join ',') -eq 'src/beta.ts'))

# ------------------------------------------------------------------- E2 -------
# Two workers change the same file in the shared directory.
Write-LfFile $sharedPath (Get-SharedContent 'from assignment A')
$afterA = Get-Content -LiteralPath $sharedPath -Raw
Write-LfFile $sharedPath (Get-SharedContent 'from assignment B')
$afterB = Get-Content -LiteralPath $sharedPath -Raw
$e2Names = @(Get-Names (Invoke-Git $repo @('diff', '--name-only', $base, '--', 'src/shared.ts') 'e20-shared-same-file-names').Stdout)
$e2Diff = Invoke-Git $repo @('diff', '--no-ext-diff', '--no-textconv', '--no-color', $base, '--', 'src/shared.ts') 'e21-shared-same-file-diff'
Add-Check -Id 'C7' -Title 'the same file in a shared directory loses a worker' `
    -Expectation "the file holds worker B's text and worker A's text is gone" `
    -Observed ("A present=" + ($afterA -like '*assignment A*') + ", B present=" + ($afterB -like '*assignment B*')) `
    -Ok (($afterB -like '*assignment B*') -and -not ($afterB -like '*assignment A*'))
Add-Check -Id 'C8' -Title 'the review diff cannot show that two workers touched the file' `
    -Expectation 'the diff names one file and one surviving change' `
    -Observed ("files=" + ($e2Names -join ', ')) `
    -Ok (($e2Names -join ',') -eq 'src/shared.ts' -and $e2Diff.Stdout.Contains('assignment B') -and
        -not $e2Diff.Stdout.Contains('assignment A'))

# ------------------------------------------------------------------- E3 -------
# The same two workers, in two isolated worktrees of the same repository.
$worktreeRoot = New-Dir (Join-Path $script:RunDir 'worktrees')
function Add-Worktree {
    param([string] $Name, [string] $Branch, [string] $StartPoint)
    $path = New-Dir (Join-Path $worktreeRoot $Name)
    $result = Invoke-Git $repo @('worktree', 'add', '-b', $Branch, $path, $StartPoint) ("e30-worktree-add-$Name")
    return [pscustomobject]@{ name = $Name; branch = $Branch; path = $path; add = $result }
}
$wtAlpha = Add-Worktree 'spike-alpha' 'spike/alpha' $base
$wtBeta = Add-Worktree 'spike-beta' 'spike/beta' $base
$wtSharedA = Add-Worktree 'spike-shared-a' 'spike/shared-a' $base
$wtSharedB = Add-Worktree 'spike-shared-b' 'spike/shared-b' $base

if ($wtAlpha.add.Code -eq 0) {
    Write-LfFile (Join-Path $wtAlpha.path 'src\alpha.ts') (Get-AlphaContent 11)
    [void](Invoke-Git $wtAlpha.path @('add', '-A') 'e31-alpha-add')
    [void](Invoke-Git $wtAlpha.path @('commit', '-m', 'spike: assignment A changed alpha.ts') 'e32-alpha-commit')
}
if ($wtBeta.add.Code -eq 0) {
    Write-LfFile (Join-Path $wtBeta.path 'src\beta.ts') (Get-BetaContent 22)
    [void](Invoke-Git $wtBeta.path @('add', '-A') 'e33-beta-add')
    [void](Invoke-Git $wtBeta.path @('commit', '-m', 'spike: assignment B changed beta.ts') 'e34-beta-commit')
}
if ($wtSharedA.add.Code -eq 0) {
    Write-LfFile (Join-Path $wtSharedA.path 'src\shared.ts') (Get-SharedContent 'from assignment A')
    [void](Invoke-Git $wtSharedA.path @('add', '-A') 'e35-shared-a-add')
    [void](Invoke-Git $wtSharedA.path @('commit', '-m', 'spike: assignment A changed shared.ts') 'e36-shared-a-commit')
}
if ($wtSharedB.add.Code -eq 0) {
    Write-LfFile (Join-Path $wtSharedB.path 'src\shared.ts') (Get-SharedContent 'from assignment B')
    [void](Invoke-Git $wtSharedB.path @('add', '-A') 'e37-shared-b-add')
    [void](Invoke-Git $wtSharedB.path @('commit', '-m', 'spike: assignment B changed shared.ts') 'e38-shared-b-commit')
}

# Different files: a merge is clean.
$wtClean = Add-Worktree 'merge-clean' 'spike/merge-clean' $base
$mergeAlpha = Invoke-Git $wtClean.path @('merge', '--no-edit', 'spike/alpha') 'e40-merge-clean-alpha'
$mergeBeta = Invoke-Git $wtClean.path @('merge', '--no-edit', 'spike/beta') 'e41-merge-clean-beta'

# The same file: a merge is a conflict, and the conflict is visible.
$wtConflict = Add-Worktree 'merge-conflict' 'spike/merge-conflict' $base
$mergeSharedA = Invoke-Git $wtConflict.path @('merge', '--no-edit', 'spike/shared-a') 'e42-merge-conflict-a'
$mergeSharedB = Invoke-Git $wtConflict.path @('merge', '--no-edit', 'spike/shared-b') 'e43-merge-conflict-b'
$conflictStatus = Invoke-Git $wtConflict.path @('status', '--porcelain') 'e44-merge-conflict-status'
$conflictText = ''
if (Test-Path -LiteralPath (Join-Path $wtConflict.path 'src\shared.ts')) {
    $conflictText = Get-Content -LiteralPath (Join-Path $wtConflict.path 'src\shared.ts') -Raw
}
Add-Check -Id 'C9' -Title 'isolated workers on different files merge without a conflict' `
    -Expectation 'both merges exit 0' `
    -Observed ("alpha merge=$($mergeAlpha.Code), beta merge=$($mergeBeta.Code)") `
    -Ok (($mergeAlpha.Code -eq 0) -and ($mergeBeta.Code -eq 0))
Add-Check -Id 'C10' -Title 'isolated workers on the same file produce a visible conflict' `
    -Expectation 'the second merge exits non-zero, git reports both modified, the file carries conflict markers' `
    -Observed ("merge=$($mergeSharedB.Code) status='" + $conflictStatus.Stdout.Trim() + "' markers=" + `
        (($conflictText -like '*<<<<<<<*') -and ($conflictText -like '*=======*') -and ($conflictText -like '*>>>>>>>*'))) `
    -Ok (($mergeSharedB.Code -ne 0) -and ($conflictStatus.Stdout -match 'UU .*shared\.ts') -and `
        ($conflictText -like '*<<<<<<<*') -and ($conflictText -like '*=======*') -and ($conflictText -like '*>>>>>>>*'))

# ------------------------------------------------------------------- E5 -------
# One diff per Assignment.
$alphaNames = @(Get-Names (Invoke-Git $wtAlpha.path @('diff', '--name-only', $base, '--') 'e50-assignment-a-diff').Stdout)
$sharedANames = @(Get-Names (Invoke-Git $wtSharedA.path @('diff', '--name-only', $base, '--') 'e51-assignment-b-diff').Stdout)
$alphaText = (Invoke-Git $wtAlpha.path @('diff', '--no-ext-diff', '--no-textconv', '--no-color', $base, '--') 'e52-assignment-a-text').Stdout
$sharedAText = (Invoke-Git $wtSharedA.path @('diff', '--no-ext-diff', '--no-textconv', '--no-color', $base, '--') 'e53-assignment-b-text').Stdout
Add-Check -Id 'C11' -Title 'each Assignment has its own diff' `
    -Expectation 'assignment A names only src\alpha.ts, assignment B only src\shared.ts, and the two texts differ' `
    -Observed ("A=" + ($alphaNames -join ', ') + " B=" + ($sharedANames -join ', ') + `
        " identical=" + ((Get-TextSha256 $alphaText) -eq (Get-TextSha256 $sharedAText))) `
    -Ok ((($alphaNames -join ',') -eq 'src/alpha.ts') -and (($sharedANames -join ',') -eq 'src/shared.ts') -and `
        ((Get-TextSha256 $alphaText) -ne (Get-TextSha256 $sharedAText)))

# ------------------------------------------------------------------- E4 -------
# One worker fails inside its own worktree: the leftovers and the cleanup scope.
$wtFail = Add-Worktree 'probe-fail' 'spike/fail' $base
$siblingBefore = [pscustomobject]@{
    status = Get-TextSha256 (Invoke-Git $wtAlpha.path @('status', '--porcelain') 'e60-sibling-status-before').Stdout
    diff = Get-TextSha256 (Invoke-Git $wtAlpha.path @('diff', $base, '--') 'e61-sibling-diff-before').Stdout
    repo = Get-TextSha256 (Invoke-Git $repo @('diff', $base, '--') 'e62-shared-diff-before').Stdout
}
Write-LfFile (Join-Path $wtFail.path 'src\alpha.ts') (Get-AlphaContent 999)
Write-LfFile (Join-Path $wtFail.path 'src\junk.tmp') "leftover of the failed worker`n"
$failStatus = Invoke-Git $wtFail.path @('status', '--porcelain') 'e63-failed-status'
$siblingAfter = [pscustomobject]@{
    status = Get-TextSha256 (Invoke-Git $wtAlpha.path @('status', '--porcelain') 'e64-sibling-status-after').Stdout
    diff = Get-TextSha256 (Invoke-Git $wtAlpha.path @('diff', $base, '--') 'e65-sibling-diff-after').Stdout
    repo = Get-TextSha256 (Invoke-Git $repo @('diff', $base, '--') 'e66-shared-diff-after').Stdout
}
$worktreeList = Invoke-Git $repo @('worktree', 'list', '--porcelain') 'e67-worktree-list'
$worktreePaths = @($worktreeList.Stdout -split "`n" | Where-Object { $_ -like 'worktree *' })
$worktreeCount = $worktreePaths.Count
$removeResult = $null
if ($failStatus.Stdout.Trim() -ne '') {
    # The worktree is dirty, so Git refuses the removal and deletes nothing. The call is made only
    # after that was confirmed, so the probe can never remove a directory.
    $fixtureRoot = (Resolve-Path -LiteralPath $script:RunDir).Path.TrimEnd('\') + '\'
    $dirtyFixture = (Resolve-Path -LiteralPath $wtFail.path).Path
    if (-not $dirtyFixture.StartsWith($fixtureRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Worktree outside the isolated run directory: $dirtyFixture"
    }
    $removeResult = Invoke-Git $repo @('worktree', 'remove', $dirtyFixture) 'e68-worktree-remove-dirty'
} else {
    $removeResult = [pscustomobject]@{ Command = 'git worktree remove (skipped)'; Code = 125; Stdout = ''; Stderr = 'skipped: the worktree was unexpectedly clean' }
}
$pruneResult = Invoke-Git $repo @('worktree', 'prune', '--dry-run', '--verbose') 'e69-worktree-prune-dry-run'
Add-Check -Id 'C12' -Title 'a failed worker leaves only its own directory dirty' `
    -Expectation 'the sibling worktree and the shared repository are byte-identical before and after the failure' `
    -Observed ("sibling status " + ($siblingBefore.status -eq $siblingAfter.status) + `
        ", sibling diff " + ($siblingBefore.diff -eq $siblingAfter.diff) + `
        ", shared diff " + ($siblingBefore.repo -eq $siblingAfter.repo) + `
        ", failed status='" + $failStatus.Stdout.Trim() + "'") `
    -Ok (($siblingBefore.status -eq $siblingAfter.status) -and ($siblingBefore.diff -eq $siblingAfter.diff) -and `
        ($siblingBefore.repo -eq $siblingAfter.repo))
Add-Check -Id 'C13' -Title 'Git refuses to remove a dirty worktree, so a cleanup is never silent' `
    -Expectation 'git worktree remove exits non-zero on the dirty worktree and deletes nothing' `
    -Observed ("exit=$($removeResult.Code) stderr='" + ($removeResult.Stderr.Trim() -replace "`n", ' ') + "'") `
    -Ok ($removeResult.Code -ne 0)
Add-Check -Id 'C14' -Title 'the cleanup scope is enumerable without deleting anything' `
    -Expectation 'worktree list shows every worktree, and the prune dry run reports its scope' `
    -Observed ("worktrees=$worktreeCount prune='" + ($pruneResult.Stdout.Trim() -replace "`n", ' | ') + "'") `
    -Ok ($worktreeCount -ge 5)

# ------------------------------------------------------------------- E6 -------
# The node's repository guard, mirrored, against every layout the spike built.
$cloneRoot = New-Dir (Join-Path $script:RunDir 'clones')
$plainClone = New-Dir (Join-Path $cloneRoot 'plain-clone')
[void](Invoke-Git '' @('clone', '--local', '--no-hardlinks', $repo, $plainClone) 'e70-clone-plain')
$sharedClone = New-Dir (Join-Path $cloneRoot 'shared-clone')
$sharedCloneResult = Invoke-Git '' @('clone', '--shared', $repo, $sharedClone) 'e71-clone-shared'
if ($sharedCloneResult.Code -ne 0) {
    # A Git that refuses --shared gets a second, separate destination; nothing is deleted to recover.
    $sharedClone = New-Dir (Join-Path $cloneRoot 'shared-clone-reference')
    $sharedCloneResult = Invoke-Git '' @('clone', '--reference', $repo, $sharedClone) 'e71b-clone-reference'
}
$extClone = New-Dir (Join-Path $cloneRoot 'ext-clone')
[void](Invoke-Git '' @('clone', $repo, $extClone) 'e72-clone-ext')
$extConfig = Join-Path $extClone '.git\config'
if (Test-Path -LiteralPath $extConfig) {
    Add-Content -LiteralPath $extConfig -Value "`n[diff]`n`texternal = diff`n" -Encoding UTF8
}
$ownRepo = New-Dir (Join-Path $cloneRoot 'own-repo')
[void](Invoke-Git $ownRepo @('init') 'e73-init-own')
Write-LfFile (Join-Path $ownRepo 'src\alpha.ts') (Get-AlphaContent 11)
[void](Invoke-Git $ownRepo @('add', '-A') 'e74-add-own')
[void](Invoke-Git $ownRepo @('commit', '-m', 'spike: independent repository') 'e75-commit-own')

$layouts = @(
    [pscustomobject]@{ name = 'shared project workspace (own .git)'; dir = $repo },
    [pscustomobject]@{ name = 'linked worktree of the project repository'; dir = $wtAlpha.path },
    [pscustomobject]@{ name = 'independent repository (own git init)'; dir = $ownRepo },
    [pscustomobject]@{ name = 'local clone (own object store)'; dir = $plainClone },
    [pscustomobject]@{ name = 'shared clone (objects/info/alternates)'; dir = $sharedClone },
    [pscustomobject]@{ name = 'clone whose own config declares diff.external'; dir = $extClone }
)
$guardRows = @()
foreach ($layout in $layouts) {
    $verdict = Test-ReviewGuard $layout.dir
    $top = Invoke-Git $layout.dir @('rev-parse', '--show-toplevel') ("e80-toplevel-" + ($layout.name -replace '[^A-Za-z0-9]', '_'))
    $gitDir = Invoke-Git $layout.dir @('rev-parse', '--git-dir') ("e81-gitdir-" + ($layout.name -replace '[^A-Za-z0-9]', '_'))
    $commonDir = Invoke-Git $layout.dir @('rev-parse', '--git-common-dir') ("e82-gitcommondir-" + ($layout.name -replace '[^A-Za-z0-9]', '_'))
    $guardRows += [pscustomobject]@{
        layout = $layout.name
        path = $layout.dir
        allowed = $verdict.ok
        reason = $verdict.reason
        showToplevel = $top.Stdout.Trim()
        gitDir = $gitDir.Stdout.Trim()
        gitCommonDir = $commonDir.Stdout.Trim()
    }
}
$script:Observations['guard'] = $guardRows
function Get-GuardRow { param([string] $Name) return ($guardRows | Where-Object { $_.layout -eq $Name } | Select-Object -First 1) }
$rowShared = Get-GuardRow 'shared project workspace (own .git)'
$rowWorktree = Get-GuardRow 'linked worktree of the project repository'
$rowOwn = Get-GuardRow 'independent repository (own git init)'
$rowPlain = Get-GuardRow 'local clone (own object store)'
$rowSharedClone = Get-GuardRow 'shared clone (objects/info/alternates)'
$rowExt = Get-GuardRow 'clone whose own config declares diff.external'
Add-Check -Id 'C15' -Title "the node's guard allows the shared project workspace of today" `
    -Expectation 'allowed, because the workspace is the root of a repository of its own' `
    -Observed ("allowed=" + $rowShared.allowed + " reason='" + $rowShared.reason + "'") `
    -Ok ([bool]$rowShared.allowed)
Add-Check -Id 'C16' -Title "the node's guard refuses a linked worktree" `
    -Expectation 'refused, because the .git of a linked worktree points at another repository' `
    -Observed ("allowed=" + $rowWorktree.allowed + " reason='" + $rowWorktree.reason + "'") `
    -Ok (-not [bool]$rowWorktree.allowed)
Add-Check -Id 'C17' -Title 'an independent repository and a local clone pass the guard' `
    -Expectation 'both allowed: their .git is a directory of their own and their objects are their own' `
    -Observed ("own=" + $rowOwn.allowed + " clone=" + $rowPlain.allowed) `
    -Ok ([bool]$rowOwn.allowed -and [bool]$rowPlain.allowed)
Add-Check -Id 'C18' -Title 'the guard refuses a shared clone and a clone with a refused configuration key' `
    -Expectation 'both refused: borrowed objects, and a configuration that names a program' `
    -Observed ("shared clone allowed=" + $rowSharedClone.allowed + " ('" + $rowSharedClone.reason + "')" + `
        " ext clone allowed=" + $rowExt.allowed + " ('" + $rowExt.reason + "')") `
    -Ok ((-not [bool]$rowSharedClone.allowed) -and $rowSharedClone.reason.Contains('borrows its objects') -and
        (-not [bool]$rowExt.allowed) -and $rowExt.reason.Contains('refused key'))

# ------------------------------------------------------------------ C19 -------
# The script's own compliance: no forbidden command ever ran.
$forbidden = @('reset --hard', 'git clean', 'rm -rf', 'rm -r ', 'Remove-Item -Recurse', 'rmdir /s')
$violations = @()
foreach ($command in $script:Commands) {
    foreach ($needle in $forbidden) {
        if ($command -like "*$needle*") { $violations += ($command + '   <- ' + $needle) }
    }
}
Add-Check -Id 'C19' -Title 'the spike itself never ran a destructive command' `
    -Expectation 'no reset --hard, no git clean, no recursive delete in any Git command line' `
    -Observed ("violations=" + $violations.Count) `
    -Ok ($violations.Count -eq 0)

# ------------------------------------------------------------------ output ----
$failed = @($script:Checks | Where-Object { -not $_.ok })
$script:Observations['meta'] = [ordered]@{
    runDirectory = $script:RunDir
    startedAt = (Get-Date).ToString('o')
    git = $gitVersion
    gitPath = $script:GitPath
    powershell = $psVersion
    platform = [System.Environment]::OSVersion.VersionString
    baselineCommit = $base
    environment = [ordered]@{
        HOME = $env:HOME
        USERPROFILE = $env:USERPROFILE
        GIT_CONFIG_GLOBAL = $env:GIT_CONFIG_GLOBAL
        GIT_CONFIG_NOSYSTEM = $env:GIT_CONFIG_NOSYSTEM
        GIT_OPTIONAL_LOCKS = $env:GIT_OPTIONAL_LOCKS
    }
}
$script:Observations['sharedWorkspace'] = [ordered]@{
    reviewDiff = $e1Diff.Stdout
    reviewFiles = $e1NameList
    reviewUntracked = (Get-Names $e1Untracked.Stdout)
    whitespace = (Get-Names $e1Whitespace.Stdout)
    snapshotAfterBoth = $snapshotOid
    snapshotFiles = $e1SnapshotNames
    sameFileDiff = $e2Diff.Stdout
}
$script:Observations['sequentialSnapshots'] = [ordered]@{
    baseline = $seqBase
    snapshotA = $snapA
    snapshotB = $snapB
    filesInWindowA = $seqBetweenA
    filesInWindowB = $seqBetweenB
}
$script:Observations['worktrees'] = [ordered]@{
    list = $worktreeList.Stdout
    cleanMerge = @($mergeAlpha.Code, $mergeBeta.Code)
    conflictMerge = @($mergeSharedA.Code, $mergeSharedB.Code)
    conflictStatus = $conflictStatus.Stdout
    conflictText = $conflictText
    assignmentDiffA = $alphaText
    assignmentDiffB = $sharedAText
}
$script:Observations['failure'] = [ordered]@{
    failedStatus = $failStatus.Stdout
    siblingStatusBefore = $siblingBefore.status
    siblingStatusAfter = $siblingAfter.status
    siblingDiffBefore = $siblingBefore.diff
    siblingDiffAfter = $siblingAfter.diff
    sharedDiffBefore = $siblingBefore.repo
    sharedDiffAfter = $siblingAfter.repo
    removeExit = $removeResult.Code
    removeStderr = $removeResult.Stderr
    pruneDryRun = $pruneResult.Stdout
}
$script:Observations['checks'] = $script:Checks

$evidence = [ordered]@{
    spike = 'P3-4 workspace isolation'
    baseline = 'Superagent next @ 3dfbf4a'
    meta = $script:Observations['meta']
    observations = [ordered]@{
        sharedWorkspace = $script:Observations['sharedWorkspace']
        sequentialSnapshots = $script:Observations['sequentialSnapshots']
        worktrees = $script:Observations['worktrees']
        failure = $script:Observations['failure']
        guard = $script:Observations['guard']
    }
    checks = $script:Checks
    summary = [ordered]@{
        total = $script:Checks.Count
        failed = $failed.Count
        verdict = if ($failed.Count -eq 0) { 'all checks matched their expectation' } else { 'at least one check did not match' }
    }
}
Write-LfFile (Join-Path $script:RunDir 'evidence.json') ($evidence | ConvertTo-Json -Depth 8)

Add-Finding -Title 'What the spike measured' -Lines @(
    "Run directory: $($script:RunDir)",
    "Git: $gitVersion",
    "Checks: $($script:Checks.Count), failed: $($failed.Count)",
    '',
    'The raw material is in git-transcript.log (every command, its exit code and its output),',
    'logs\ (the full stdout and stderr of each command), checks.md and evidence.json.'
)

Write-Host ''
Write-Host "Checks: $($script:Checks.Count), failed: $($failed.Count)"
if ($failed.Count -gt 0) {
    foreach ($check in $failed) { Write-Host ("  FAILED {0} {1}: {2}" -f $check.id, $check.title, $check.observed) }
}
Write-Host "Evidence: $(Join-Path $script:RunDir 'evidence.json')"
Write-Host "Run directory kept for re-verification: $($script:RunDir)"
if ($failed.Count -gt 0) { exit 1 }
exit 0
