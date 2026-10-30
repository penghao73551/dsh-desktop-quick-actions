// dsh-desktop-quick-actions — browser half.
// Hand-written client bundle for window.__ModuleLoader__.load (no build step).
// Registers two round icon buttons at the sidebar foot: restart the desktop app,
// open the DeepSeek top-up page in the system browser.
// The `id` must match this package's name: the module system keys bundles by the boot graph row.
window.__ModuleLoader__.load({
  id: 'dsh-desktop-quick-actions',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var TOPUP_URL = 'https://platform.deepseek.com/top_up'
    var RESTART_PATH = '/dsh-quick-actions/restart'
    var OPEN_PATH = '/dsh-quick-actions/open'

    // Stroke paths on a 24x24 grid; the button itself is the circle.
    var GLYPH_RESTART = [
      'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8',
      'M21 3v5h-5',
    ]
    var GLYPH_YEN = ['M12 11.5V18.5', 'M8 6.5l4 5 4-5', 'M8.5 13h7', 'M8.5 15.8h7']
    var GLYPH_CHECK = ['M5 12.5l4.5 4.5L19 7']
    var GLYPH_CROSS = ['M7 7l10 10', 'M17 7L7 17']

    var CSS = [
      '.dqa-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
      '.dqa-col { flex-direction: column; align-items: center; gap: 6px; }',
      '.dqa-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.30)); background: transparent; color: var(--dsw-alias-label-secondary, inherit); line-height: 0; cursor: pointer; transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease; }',
      '.dqa-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); color: var(--dsw-alias-label-primary, inherit); }',
      '.dqa-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe); outline-offset: 1px; }',
      '.dqa-btn:active { transform: scale(0.94); }',
      '.dqa-btn:disabled { opacity: 0.55; cursor: default; }',
      '.dqa-btn svg { display: block; }',
      '.dqa-danger { border-color: var(--dsw-alias-state-error-primary, #e5484d); color: var(--dsw-alias-state-error-primary, #e5484d); }',
      '.dqa-danger:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 14%, transparent); color: var(--dsw-alias-state-error-primary, #e5484d); }',
      '.dqa-note { width: 100%; font-size: 11px; line-height: 1.4; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9)); }',
      '.dqa-note-rail { width: auto; max-width: 54px; text-align: center; font-size: 10px; }',
    ].join('\n')

    function postJson(path, body) {
      return fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body === undefined ? {} : body),
      }).then(function (response) {
        return response.json().then(
          function (parsed) {
            return parsed
          },
          function () {
            return { ok: false, error: 'HTTP ' + response.status }
          },
        )
      })
    }

    function makeComponent(React) {
      var h = React.createElement

      function glyph(paths) {
        return h(
          'svg',
          {
            viewBox: '0 0 24 24',
            width: 17,
            height: 17,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.9,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
          },
          paths.map(function (d, index) {
            return h('path', { key: index, d: d })
          }),
        )
      }

      return function DesktopQuickActions(props) {
        var wide = !(props !== undefined && props !== null && props.wide === false)
        var confirmState = React.useState(false)
        var confirming = confirmState[0]
        var setConfirming = confirmState[1]
        var busyState = React.useState(false)
        var busy = busyState[0]
        var setBusy = busyState[1]
        var noteState = React.useState('')
        var note = noteState[0]
        var setNote = noteState[1]
        var rootRef = React.useRef(null)

        // Self-report: prove in the host log that the buttons actually rendered, and where.
        // Reporting is best-effort only: it must never break the buttons themselves.
        React.useEffect(function () {
          try {
            var element = rootRef.current
            if (element === null || typeof element.getBoundingClientRect !== 'function') return
            var rect = element.getBoundingClientRect()
            postJson('/dsh-quick-actions/rendered', {
              rect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                w: Math.round(rect.width),
                h: Math.round(rect.height),
              },
              wide: wide,
              vw: typeof window === 'undefined' ? 0 : window.innerWidth,
              vh: typeof window === 'undefined' ? 0 : window.innerHeight,
            }).catch(function () {})
          } catch (error) {
            /* the geometry report is diagnostics; the buttons must survive it */
          }
        }, [])

        function restart() {
          setBusy(true)
          setNote('正在重启桌面端…')
          postJson(RESTART_PATH, {})
            .then(function (result) {
              if (result !== null && result.ok === true) {
                setNote('已发出重启指令…')
                return
              }
              setBusy(false)
              setConfirming(false)
              setNote('重启失败：' + ((result !== null && result.error) || '未知错误'))
            })
            .catch(function (error) {
              setBusy(false)
              setConfirming(false)
              setNote('重启请求没发出去：' + String(error))
            })
        }

        function topup() {
          setNote('正在打开充值页…')
          postJson(OPEN_PATH, { url: TOPUP_URL })
            .then(function (result) {
              if (result !== null && result.ok === true) {
                setNote('已打开充值页')
                return
              }
              if (typeof window !== 'undefined' && typeof window.open === 'function') {
                window.open(TOPUP_URL, '_blank', 'noopener')
              }
              setNote('已尝试打开充值页')
            })
            .catch(function () {
              if (typeof window !== 'undefined' && typeof window.open === 'function') {
                window.open(TOPUP_URL, '_blank', 'noopener')
              }
              setNote('已尝试打开充值页')
            })
        }

        var noteClass = 'dqa-note' + (wide ? '' : ' dqa-note-rail')

        if (confirming) {
          return h(
            'div',
            { ref: rootRef, className: 'dqa-row' + (wide ? '' : ' dqa-col') },
            h(
              'button',
              {
                type: 'button',
                className: 'dqa-btn dqa-danger',
                title: '确认重启桌面端（正在跑的对话会中断）',
                'aria-label': '确认重启桌面端',
                disabled: busy,
                onClick: restart,
              },
              glyph(GLYPH_CHECK),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dqa-btn',
                title: '取消',
                'aria-label': '取消重启',
                disabled: busy,
                onClick: function () {
                  setConfirming(false)
                  setNote('')
                },
              },
              glyph(GLYPH_CROSS),
            ),
            note !== '' ? h('span', { className: noteClass }, note) : h('span', { className: noteClass }, '现在重启？'),
          )
        }

        return h(
          'div',
          { ref: rootRef, className: 'dqa-row' + (wide ? '' : ' dqa-col') },
          h(
            'button',
            {
              type: 'button',
              className: 'dqa-btn',
              title: '重启桌面端（改完插件点这里，会自动关掉重开）',
              'aria-label': '重启桌面端',
              disabled: busy,
              onClick: function () {
                setConfirming(true)
                setNote('')
              },
            },
            glyph(GLYPH_RESTART),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dqa-btn',
              title: '去 DeepSeek 充值（用默认浏览器打开）',
              'aria-label': '去 DeepSeek 充值',
              disabled: busy,
              onClick: topup,
            },
            glyph(GLYPH_YEN),
          ),
          note !== '' ? h('span', { className: noteClass }, note) : null,
        )
      }
    }

    function apply(ctx) {
      var React
      try {
        React = require('react')
      } catch (error) {
        console.error('[dsh-desktop-quick-actions] react unavailable: ' + error)
        return
      }
      if (React === null || React === undefined || typeof React.createElement !== 'function') {
        console.error('[dsh-desktop-quick-actions] react module has no createElement')
        return
      }

      var style = document.createElement('style')
      style.dataset.plugin = 'dsh-desktop-quick-actions'
      style.textContent = CSS
      document.head.appendChild(style)
      if (typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return function () {
            style.remove()
          }
        }, 'desktop-quick-actions: styles')
      }

      if (typeof ctx.inject !== 'function') return
      var Component = makeComponent(React)
      ctx.inject(['slots'], function (scope) {
        scope.slots.inject('sidebar.footer.action', function* () {
          yield scope.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'desktop-quick-actions',
              order: 20,
              label: '重启 / 充值',
            },
            Component,
          )
        })
      })
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
