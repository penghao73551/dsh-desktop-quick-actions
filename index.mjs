/**
 * dsh-desktop-quick-actions — host half.
 *
 * Exposes four same-origin routes for the browser half:
 *   GET  /dsh-quick-actions/info     — diagnostics (app pid, exe path, helper presence)
 *   POST /dsh-quick-actions/restart  — relaunch the desktop app through a detached helper
 *   POST /dsh-quick-actions/open     — open an https URL in the system default browser
 *   POST /dsh-quick-actions/rendered — the client reports where it painted (layout probe)
 *
 * The restart route only *starts* a detached helper; the helper waits for this response,
 * stops the app, waits for the port to free, and starts the app again. The port is taken
 * from the incoming request, never hardcoded — the desktop host picks a fresh port on every
 * launch, so any constant would be wrong on the next start.
 *
 * Nothing here may throw at import time: a failed loader entry shows the desktop's recovery
 * dialog, so every step is guarded and reported to ~/.dsh/desktop-quick-actions.log.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HELPER_PATH = join(HERE, 'lib', 'relaunch.ps1')
const LOG_PATH = join(homedir(), '.dsh', 'desktop-quick-actions.log')
const TOPUP_URL = 'https://platform.deepseek.com/top_up'

export const name = 'dsh-desktop-quick-actions'
export const inject = []

/** Append one line to the plugin log and the host console; never throws. */
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`
  try {
    console.log(`[quick-actions] ${message}`)
  } catch {
    /* console may be detached; the file log below is the durable channel */
  }
  try {
    appendFileSync(LOG_PATH, `${line}\n`, 'utf8')
  } catch {
    /* logging must never break the plugin */
  }
}

function describe(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read the port this request actually arrived on. The desktop host binds a fresh port on
 * every launch, so the request's own Host header is the only reliable source.
 * @returns a positive port number, or 0 when it cannot be determined.
 */
function portFromRequest(req) {
  const host = req && req.headers ? req.headers.host : ''
  const text = typeof host === 'string' ? host : ''
  const match = text.match(/:(\d{1,5})$/)
  if (match === null) return 0
  const port = Number(match[1])
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0
}

/**
 * Locate the desktop executable by walking up from this host's own node runtime:
 * <app>/resources/runtime/primary-runtime/dependencies/node/bin/node.exe → <app>/DeepSeek Harness.exe
 * @returns the executable path, or an empty string when no candidate exists.
 */
function appExeFromAncestors() {
  const names = ['DeepSeek Harness.exe', 'DeepSeekHarness.exe']
  let dir = dirname(process.execPath)
  for (let depth = 0; depth < 12; depth += 1) {
    for (const candidate of names) {
      const path = join(dir, candidate)
      if (existsSync(path)) return path
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return ''
}

/** Run a command and collect stdout; resolves to '' on any failure (never rejects). */
function capture(command, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    let output = ''
    let child
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolvePromise('')
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* the child may already be gone */
      }
      resolvePromise(output)
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      output += String(chunk)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolvePromise('')
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolvePromise(output)
    })
  })
}

/** Resolve the running app's executable: ancestor scan first, WMI by parent pid second. */
async function resolveAppExe(pid) {
  const fromAncestors = appExeFromAncestors()
  if (fromAncestors !== '') return fromAncestors
  if (!Number.isInteger(pid) || pid <= 0) return ''
  const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}").ExecutablePath`
  const output = await capture(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    8000,
  )
  const first = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '')
  if (first !== undefined && first.toLowerCase().endsWith('.exe') && existsSync(first)) return first
  return ''
}

/** Child environment with the injected loader removed, so the relaunched app starts clean. */
function cleanEnv() {
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  return env
}

/** Start the detached relaunch helper. Returns false when the launch itself fails. */
function launchRelaunchHelper(pid, exePath, port) {
  // Three measured facts decide this shape:
  //  1. A console-subsystem child created by WMI gets a console, and Windows 11 hands every
  //     new console to Windows Terminal, which ignores SW_HIDE and paints a visible window.
  //     That window is what the user kept closing - and closing it killed the app, because
  //     the app had been started as a child of that console.
  //  2. `detached: true` (DETACHED_PROCESS) leaves powershell.exe with no console; it then
  //     exits without running the script.
  //  3. A plainly spawned child dies together with this host, and this host dies when the
  //     app it just killed goes down - the helper would never reach the relaunch.
  // So: WMI creates wscript.exe (GUI subsystem, no console at all), and the VBScript it runs
  // starts powershell with window style 0 (hidden) and does not wait. No console is ever
  // painted, and relaunch.ps1 starts the app through WMI so it inherits no console either.
  const portArg = Number.isInteger(port) && port > 0 ? ` -Port ${String(port)}` : ''
  const inner =
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${HELPER_PATH}"`
    + ` -AppPid ${String(pid)} -AppExe "${exePath}"${portArg}`
  const vbsPath = join(tmpdir(), `dsh-quick-restart-${String(pid)}.vbs`)
  try {
    const vbs = [
      'Dim s',
      `s = "${inner.replace(/"/g, '""')}"`,
      'CreateObject("WScript.Shell").Run s, 0, False',
      '',
    ].join('\r\n')
    // UTF-16LE with BOM: the helper path may contain non-ASCII characters.
    writeFileSync(vbsPath, `\ufeff${vbs}`, 'utf16le')
  } catch (error) {
    log(`vbs write failed: ${describe(error)}`)
    return false
  }
  const command =
    `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='wscript.exe //nologo "${vbsPath}"'} | Out-Null`
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
      env: cleanEnv(),
    })
    child.on('error', (error) => {
      log(`relaunch launcher error event: ${describe(error)}`)
    })
    child.unref()
    log(
      `relaunch helper requested through WMI+wscript (app pid ${String(pid)}, port ${String(port)}, exe ${exePath})`,
    )
    return true
  } catch (error) {
    log(`relaunch launcher spawn failed: ${describe(error)}`)
    return false
  }
}

/** Open one https URL in the OS default browser without a console window. */
function openExternally(url) {
  const attempts = [
    ['rundll32.exe', ['url.dll,FileProtocolHandler', url]],
    ['explorer.exe', [url]],
  ]
  for (const [command, args] of attempts) {
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: cleanEnv(),
      })
      child.unref()
      log(`opened externally via ${command}: ${url}`)
      return true
    } catch (error) {
      log(`${command} failed: ${describe(error)}`)
    }
  }
  return false
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > 65536) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

export function apply(ctx) {
  if (typeof ctx.inject !== 'function') {
    log('ctx.inject unavailable; plugin inactive')
    return
  }
  ctx.inject(['webServer'], (scope) => {
    const webServer = scope.webServer
    if (!webServer || typeof webServer.register !== 'function') {
      log('webServer unavailable; routes skipped')
      return
    }
    log(`host half active (app pid ${String(process.ppid)}, helper ${existsSync(HELPER_PATH) ? 'present' : 'MISSING'})`)

    webServer.register({
      name: 'dsh-quick-actions-info',
      kind: 'exact',
      path: '/dsh-quick-actions/info',
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
          return json(res, 200, {
            ok: true,
            probe: 'v3',
            appPid: Number(process.ppid),
            appExe: appExeFromAncestors(),
            helper: existsSync(HELPER_PATH),
            topup: TOPUP_URL,
            port: portFromRequest(req),
            platform: process.platform,
            log: LOG_PATH,
          })
        } catch (error) {
          return json(res, 500, { ok: false, error: describe(error) })
        }
      },
    })

    webServer.register({
      name: 'dsh-quick-actions-rendered',
      kind: 'exact',
      path: '/dsh-quick-actions/rendered',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
          const body = await readJsonBody(req)
          const rect = body.rect && typeof body.rect === 'object' ? body.rect : {}
          log(
            `client rendered at x=${String(rect.x)} y=${String(rect.y)} w=${String(rect.w)} h=${String(rect.h)}` +
              ` viewport=${String(body.vw)}x${String(body.vh)} wide=${String(body.wide)}`,
          )
          return json(res, 200, { ok: true })
        } catch (error) {
          return json(res, 500, { ok: false, error: describe(error) })
        }
      },
    })

    webServer.register({
      name: 'dsh-quick-actions-restart',
      kind: 'exact',
      path: '/dsh-quick-actions/restart',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
          if (process.platform !== 'win32') {
            return json(res, 501, { ok: false, error: 'restart is only implemented on Windows' })
          }
          if (!existsSync(HELPER_PATH)) {
            log('restart refused: helper script missing')
            return json(res, 500, {
              ok: false,
              error: 'restart helper script is missing; quit the app from the tray and open it again',
            })
          }
          const pid = Number(process.ppid)
          const exePath = await resolveAppExe(pid)
          if (exePath === '') {
            log('restart refused: app executable not found')
            return json(res, 500, {
              ok: false,
              error: 'could not locate the desktop executable; quit the app from the tray and open it again',
            })
          }
          const port = portFromRequest(req)
          if (!launchRelaunchHelper(pid, exePath, port)) {
            return json(res, 500, { ok: false, error: 'failed to start the restart helper' })
          }
          return json(res, 200, { ok: true, appPid: pid, appExe: exePath, port })
        } catch (error) {
          log(`restart failed: ${describe(error)}`)
          return json(res, 500, { ok: false, error: describe(error) })
        }
      },
    })

    webServer.register({
      name: 'dsh-quick-actions-open',
      kind: 'exact',
      path: '/dsh-quick-actions/open',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
          const body = await readJsonBody(req)
          const url = typeof body.url === 'string' ? body.url.trim() : ''
          if (!/^https:\/\/[^\s]+$/i.test(url)) {
            return json(res, 400, { ok: false, error: 'only https urls are accepted' })
          }
          const opened = openExternally(url)
          return json(res, opened ? 200 : 500, opened ? { ok: true, url } : { ok: false, error: 'browser did not start' })
        } catch (error) {
          return json(res, 500, { ok: false, error: describe(error) })
        }
      },
    })
  })
}
