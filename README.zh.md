# dsh-desktop-quick-actions

在 DSH 桌面端侧栏底部放两个圆形按钮：

- **重启** —— 关掉 App 再拉起来，**全程不弹黑窗**。
- **充值** —— 用系统浏览器打开 DeepSeek 充值页。

重启那一半只在 Windows 上实现（依赖 WMI）。充值按钮在哪个桌面平台都能用。

---

## 为什么还要另做一个重启按钮

最直觉的写法是四行：`taskkill` 然后 `spawn(可执行文件)`。它会在一个很难从代码里看出来的地方失败。

通过 WMI 创建的、控制台子系统（console-subsystem）的子进程会拿到一个自己的控制台。而 Windows 11 把这个新控制台**交给 Windows Terminal 接管** —— 终端是独立进程，它不理会 `SW_HIDE`，也不理会 `-WindowStyle Hidden`。于是：

1. 弹出一个黑色终端窗口。
2. 你把它关掉，因为留着也没用。
3. 关窗会给挂在这个控制台上的所有进程发 `CTRL_CLOSE_EVENT` ——
   **包括那个被它当子进程启动起来的 App**。

App 刚回来几秒又死了。日志里什么也没有，因为没有任何东西崩溃：窗口管理器只是照做了。

实测环境：Windows 11、DSH 桌面端 0.2.1-rc 系列。修之前每次重启都亮一个 `WindowsTerminal.exe`；修之后 `Get-Process WindowsTerminal` 没有任何输出，重启日志把整条路径写清楚。

### 修法为什么是两层

| 层 | 机制 | 为什么必须这样 |
|---|---|---|
| 启动器 | `Invoke-CimMethod Win32_Process Create` 起 **`wscript.exe`**，由它执行生成的 `.vbs`：`WScript.Shell.Run cmd, 0, False` | `wscript.exe` 是 GUI 子系统程序，**从一开始就不分配控制台**。没有控制台，Terminal 就没有东西可接管。 |
| 启动 App | App 自己也用 `Invoke-CimMethod Win32_Process Create` 起 | 新进程的父进程是 `WmiPrvSE.exe`，不继承任何控制台，之后谁关窗都碰不到它。 |

WMI 不可用时回退到 `Start-Process`。

## 端口是读出来的，不是写死的

桌面端**每次启动都会换一个新端口**。任何写死的端口号，从第二次重启起就是错的。宿主侧读 `req.headers.host` —— 触发重启的那个请求本来就知道端口 —— 再以 `-Port` 传给助手脚本。读不出来时，助手脚本跳过端口检查、改等进程，慢一点但不会判错。

## 安装

```bash
dsh plugin --profile desktop add dsh-desktop-quick-actions
```

手动重启一次 App，之后按钮就可用。

## 路由

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/dsh-quick-actions/info` | 诊断：App pid、exe 路径、助手脚本在不在、充值地址、探测到的端口、平台 |
| `POST` | `/dsh-quick-actions/restart` | 拉起分离的重启助手 |
| `POST` | `/dsh-quick-actions/open` | 用默认浏览器打开一个 `https://` 地址 |
| `POST` | `/dsh-quick-actions/rendered` | 客户端回报自己画在哪（版式探针） |

`/open` **只接受 `https://`** —— 不收 `file:`、不收 `javascript:`、不收裸路径。

## 安全边界

- 助手脚本先读目标 pid 的 `ExecutablePath`，**和它准备启动的那个可执行文件不一致就中止**。绝不会因为 pid 被复用而误杀。
- 保留原始命令行，所以 `--user-data-dir` 这类自定义参数能带过去。
- 子进程环境里剥掉 `NODE_OPTIONS`，避免重启后的 App 继承注入的 loader。
- 每一步都写 `~/.dsh/desktop-quick-actions.log`。重启失败时，那个文件会说是哪一步拒绝的。

## 怎么验证一次重启是干净的

```powershell
Get-Content "$env:USERPROFILE\.dsh\desktop-quick-actions.log" -Tail 20
Get-Process WindowsTerminal -ErrorAction SilentlyContinue   # 应该没有输出
```

一次正常的长这样：

```
relaunch: helper start: pid=41828 exe=<install>\DeepSeek Harness.exe port=54264
relaunch: stopping app process
relaunch: starting app via WMI: "<install>\DeepSeek Harness.exe" ...
relaunch: wmi start ok: new pid=39380
relaunch: app is up again; done
```

## 兼容性

- DSH 桌面端 `0.2.1-rc.*` 及以上。需要 `webServer` 服务 —— 桌面宿主提供；在普通 `dsh web` profile 里路由会被跳过并在日志里说明原因。
- 重启那一半要 Windows 10/11。Node 20+。
- 导入期绝不抛错：加载失败的条目会让桌面端弹恢复对话框，所以每一步都包了 try 并写日志。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-desktop-quick-actions
```

## 许可

MIT。
