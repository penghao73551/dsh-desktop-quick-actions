# dsh-desktop-quick-actions

Two round buttons at the foot of the DSH desktop sidebar:

- **Restart** — closes the app and starts it again, **without a console window ever appearing**.
- **Top up** — opens the DeepSeek top-up page in your system browser.

Windows only (the restart helper leans on WMI). The top-up button works anywhere the desktop
app runs.

---

## Why another restart button

The obvious version of this plugin is four lines: `spawn('taskkill', ...)` then
`spawn(exe)`. It fails in a way that is hard to guess from the code.

A console-subsystem child created through WMI gets a console of its own. On Windows 11 the
system hands every new console to **Windows Terminal**, which is a separate process that
ignores `SW_HIDE` and `-WindowStyle Hidden`. So:

1. A black terminal window appears.
2. You close it, because why would you keep it.
3. Closing it sends `CTRL_CLOSE_EVENT` to everything attached to that console —
   **including the app that was started as its child**.

The app dies a few seconds after it came back. Nothing in the log says why, because nothing
crashed: the window manager did exactly what it was told.

Measured on Windows 11 with DSH desktop 0.2.1-rc series. Before the fix: every
restart painted a `WindowsTerminal.exe` window. After: `Get-Process WindowsTerminal` returns
nothing, and the relaunch log shows the whole path.

### What the fix does

Two layers, because one is not enough:

| Layer | Mechanism | Why |
|---|---|---|
| Launcher | `Invoke-CimMethod Win32_Process Create` → **`wscript.exe`** running a generated `.vbs` with `WScript.Shell.Run cmd, 0, False` | `wscript.exe` is a GUI-subsystem program: it never allocates a console to begin with. No console, nothing for Terminal to take over. |
| App start | `Invoke-CimMethod Win32_Process Create` for the app itself | The new process is owned by `WmiPrvSE.exe` and inherits no console, so no later window closing can reach it. |

`Start-Process` remains as a fallback if WMI is unavailable.

## The port is read, never assumed

The desktop host binds a **fresh port on every launch**. A hardcoded port number is wrong by
the second restart. The host half reads `req.headers.host` — the request that triggered the
restart already knows the port — and passes it to the helper as `-Port`. When it cannot be
determined, the helper skips the port checks and waits on the process instead.

## Install

```bash
dsh plugin --profile desktop add dsh-desktop-quick-actions
```

Restart the app once by hand. After that, the button works.

## Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/dsh-quick-actions/info` | Diagnostics: app pid, exe path, helper present, top-up URL, detected port, platform |
| `POST` | `/dsh-quick-actions/restart` | Start the detached helper |
| `POST` | `/dsh-quick-actions/open` | Open an `https://` URL in the default browser |
| `POST` | `/dsh-quick-actions/rendered` | Client reports where it painted (layout probe) |

`/open` accepts **only `https://`** — no `file:`, no `javascript:`, no bare paths.

## Safety

- The helper reads the target pid's `ExecutablePath` first and **aborts** if it does not match
  the executable it is about to start. It never kills a process that merely inherited the pid.
- The original command line is preserved, so custom flags such as `--user-data-dir` survive a restart.
- `NODE_OPTIONS` is stripped from the child environment so the relaunched app does not inherit
  an injected loader.
- Every step appends to `~/.dsh/desktop-quick-actions.log`. If a restart fails, that file says
  which step refused and why.

## Verify a restart

```powershell
# after clicking the button
Get-Content "$env:USERPROFILE\.dsh\desktop-quick-actions.log" -Tail 20
Get-Process WindowsTerminal -ErrorAction SilentlyContinue   # expect no output
```

A healthy run looks like:

```
relaunch: helper start: pid=41828 exe=<install>\DeepSeek Harness.exe port=54264
relaunch: stopping app process
relaunch: starting app via WMI: "<install>\DeepSeek Harness.exe" ...
relaunch: wmi start ok: new pid=39380
relaunch: app is up again; done
```

## Compatibility

- DSH desktop `0.2.1-rc.*` and later. Needs the `webServer` service, which the desktop host
  provides; in a plain `dsh web` profile the routes are skipped and the plugin logs why.
- Windows 10/11 for the restart half. Node 20+.
- Nothing throws at import time — a failed loader entry makes the desktop app show its
  recovery dialog, so every step is guarded and logged.

## Uninstall

```bash
dsh plugin --profile desktop remove dsh-desktop-quick-actions
```

## License

MIT.
