/**
 * Skill manager — browser half.
 *
 * One trigger button in the Session toolbar and one panel in the frame-wide
 * overlay layer. The panel lists every skill the Session workspace can see and
 * lets the user switch one off, or limit it to a set of workspaces. Both go
 * through the Host half (`/skill-manager/api`) so the Client never edits state
 * on its own.
 */

window.__ModuleLoader__.load({
  id: 'dsh-skill-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-skill-manager'
    const API = '/skill-manager/api'
    const TRIGGER_ID = 'skill-manager'
    const PANEL_ID = 'skill-manager-panel'

    const STRINGS = {
      en: {
        open: 'Manage skills',
        title: 'Skill manager',
        summary: '{hidden} of {total} skills hidden',
        loading: 'Loading…',
        empty: 'No skills found for this workspace.',
        close: 'Close',
        toggleOn: 'Disable {name}',
        toggleOff: 'Enable {name}',
        badgeOff: 'disabled',
        badgeAll: 'all workspaces',
        badgeScoped: '{count} workspace(s)',
        badgeOutside: 'outside scope',
        scopeButton: 'Workspaces ({count})',
        scopeAdd: 'Limit workspaces…',
        scopeAll: 'Available in every workspace.',
        scopeListed: 'Only available inside these workspaces:',
        addWorkspace: 'Add workspace…',
        adding: 'Choosing…',
        clearScope: 'Remove restriction',
        removeWorkspace: 'Remove {path}',
        footnote: 'Changes apply from the next step: a hidden skill leaves the model skill catalog and the / menu.',
        outside: 'The current workspace is outside the allowed list, so the skill stays hidden here.',
        collapse: 'Hide workspaces',
        retry: 'Retry',
        requestFailed: 'Request failed',
      },
      zh: {
        open: '管理技能',
        title: '技能管理',
        summary: '共 {total} 个技能，{hidden} 个已隐藏',
        loading: '加载中…',
        empty: '当前工作区没有技能。',
        close: '关闭',
        toggleOn: '停用 {name}',
        toggleOff: '启用 {name}',
        badgeOff: '已停用',
        badgeAll: '所有工作区',
        badgeScoped: '限 {count} 个工作区',
        badgeOutside: '范围外',
        scopeButton: '工作区（{count}）',
        scopeAdd: '限定工作区…',
        scopeAll: '在所有工作区都可用。',
        scopeListed: '只在下列工作区内可用：',
        addWorkspace: '添加工作区…',
        adding: '选择中…',
        clearScope: '取消限制',
        removeWorkspace: '移除 {path}',
        footnote: '改动从下一步生效：隐藏的技能会从模型技能清单和 / 菜单里消失。',
        outside: '当前工作区不在允许列表内，该技能在此会话中仍然隐藏。',
        collapse: '收起工作区',
        retry: '重试',
        requestFailed: '请求失败，请重试。',
      },
    }

    let locale = 'en'
    let translate = null
    /** Latest workspace seen on a Session toolbar render; scopes the panel listing. */
    let sessionCwd = null
    /** Latest Session identity seen on a toolbar render; selects its catalog view. */
    let sessionId = null

    function interpolate(template, params) {
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, (match, key) => {
        const value = params[key]
        return value === undefined ? match : String(value)
      })
    }

    function t(key, params) {
      let text
      if (translate) {
        try {
          const translated = translate(key)
          if (typeof translated === 'string' && translated !== key) text = translated
        } catch {
          text = undefined
        }
      }
      if (text === undefined) {
        const dict = STRINGS[locale] ?? STRINGS.en
        text = dict[key] ?? STRINGS.en[key] ?? key
      }
      return interpolate(text, params)
    }

    function message(error) {
      if (error && typeof error.message === 'string' && error.message !== '') return error.message
      return t('requestFailed')
    }

    function extractCwd(session) {
      if (!session || typeof session !== 'object') return null
      const candidates = [
        session.cwd,
        session.workingDirectory,
        session.workspace && session.workspace.path,
        session.workspace && session.workspace.cwd,
        session.projection && session.projection.cwd,
      ]
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
      }
      return null
    }

    /** Single shared store: the trigger and the panel are sibling slots, not one React tree. */
    const store = {
      state: { open: false, loading: false, busy: '', error: '', data: null },
      listeners: new Set(),
      subscribe(listener) {
        store.listeners.add(listener)
        return () => {
          store.listeners.delete(listener)
        }
      },
      snapshot() {
        return store.state
      },
      notify() {
        store.listeners.forEach(listener => {
          try {
            listener()
          } catch {
            // A failing subscriber must not block the others.
          }
        })
      },
      set(patch) {
        store.state = Object.assign({}, store.state, patch)
        store.notify()
      },
    }

    function useStore() {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(store.subscribe, store.snapshot)
      }
      const [snapshot, setSnapshot] = React.useState(store.snapshot())
      React.useEffect(() => store.subscribe(() => setSnapshot(store.snapshot())), [])
      return snapshot
    }

    function buildUrl(pathname, query) {
      let url = API + pathname
      if (query) {
        const search = Object.keys(query)
          .filter(key => typeof query[key] === 'string' && query[key] !== '')
          .map(key => `${key}=${encodeURIComponent(query[key])}`)
          .join('&')
        if (search !== '') url += `${url.indexOf('?') === -1 ? '?' : '&'}${search}`
      }
      return url
    }

    async function request(pathname, options) {
      const settings = options || {}
      const headers = { accept: 'application/json', 'x-skill-manager': '1' }
      const init = {
        method: settings.method || 'GET',
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
      }
      if (settings.body !== undefined) {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify(settings.body)
      }
      const response = await fetch(buildUrl(pathname, settings.query), init)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) throw new Error((payload && (payload.error || payload.text)) || `HTTP ${response.status}`)
      if (payload && payload.ok === false) throw new Error(payload.error || t('requestFailed'))
      return payload
    }

    let refreshing = null

    async function refresh() {
      if (refreshing) return refreshing
      store.set({ loading: true, error: '' })
      refreshing = request('/state', { query: { cwd: sessionCwd, session: sessionId } })
        .then(data => {
          store.set({ data, loading: false })
        })
        .catch(error => {
          store.set({ loading: false, error: message(error) })
        })
        .then(() => {
          refreshing = null
        })
      return refreshing
    }

    async function apply(pathname, body) {
      const payload = Object.assign({}, body, { cwd: sessionCwd, session: sessionId })
      store.set({ busy: body.name, error: '' })
      try {
        const result = await request(pathname, { method: 'POST', body: payload })
        if (result && result.listing) {
          store.set({ data: result.listing })
        } else {
          await refresh()
        }
      } catch (error) {
        store.set({ error: message(error) })
      } finally {
        store.set({ busy: '' })
      }
    }

    /** Element that had focus when the panel opened; focus returns there on close. */
    let lastFocus = null

    function openPanel() {
      try {
        lastFocus = document.activeElement
      } catch {
        lastFocus = null
      }
      store.set({ open: true, data: null, error: '' })
      void refresh()
    }

    function closePanel() {
      store.set({ open: false })
      try {
        if (lastFocus && lastFocus.isConnected && typeof lastFocus.focus === 'function') lastFocus.focus()
      } catch {
        // A detached trigger cannot take focus back.
      }
      lastFocus = null
    }

    function shortPath(value) {
      const text = String(value)
      const separator = text.indexOf('/') === -1 ? '\\' : '/'
      const parts = text.split(/[\\/]+/).filter(Boolean)
      if (parts.length <= 2) return text
      return `…${separator}${parts.slice(-2).join(separator)}`
    }

    function icon(kind) {
      const common = {
        width: 16,
        height: 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }
      if (kind === 'close') return h('svg', common, h('path', { d: 'M6 6l12 12M18 6L6 18' }))
      return h(
        'svg',
        common,
        h('path', { d: 'M3.5 6h17M3.5 12h17M3.5 18h17' }),
        h('circle', { cx: 9, cy: 6, r: 2.1, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 15, cy: 12, r: 2.1, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 8, cy: 18, r: 2.1, fill: 'currentColor', stroke: 'none' }),
      )
    }

    function Trigger(props) {
      const snapshot = useStore()
      let cwd = null
      try {
        const session = props && typeof props.useSession === 'function' ? props.useSession() : null
        cwd = extractCwd(session)
      } catch {
        cwd = null
      }
      if (cwd) sessionCwd = cwd
      if (props && typeof props.sessionId === 'string' && props.sessionId !== '') sessionId = props.sessionId

      return h(
        'button',
        {
          type: 'button',
          className: 'dshskm-trigger',
          'data-active': snapshot.open ? 'true' : 'false',
          title: t('open'),
          'aria-label': t('open'),
          'aria-haspopup': 'dialog',
          'aria-controls': PANEL_ID,
          'aria-expanded': snapshot.open ? 'true' : 'false',
          onClick: () => {
            if (snapshot.open) closePanel()
            else openPanel()
          },
        },
        icon('sliders'),
      )
    }

    function Switch(props) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          className: 'dshskm-switch',
          'data-checked': props.checked ? 'true' : 'false',
          'aria-checked': props.checked ? 'true' : 'false',
          'aria-label': props.label,
          title: t(props.checked ? 'toggleOn' : 'toggleOff', { name: props.label }),
          disabled: props.disabled === true,
          onClick: props.onToggle,
        },
        h('span', { className: 'dshskm-knob' }),
      )
    }

    function Badge(props) {
      const skill = props.skill
      let text
      if (!skill.enabled) text = t('badgeOff')
      else if (skill.workspaces.length === 0) text = t('badgeAll')
      else if (!skill.inScope) text = t('badgeOutside')
      else text = t('badgeScoped', { count: skill.workspaces.length })
      return h('span', { className: 'dshskm-badge', 'data-tone': props.tone || 'neutral' }, text)
    }

    function ScopeEditor(props) {
      const skill = props.skill
      const [picking, setPicking] = React.useState(false)
      const scopeRef = React.useRef(null)

      // The panel body is a capped scroll container: reveal the editor that just opened.
      React.useEffect(() => {
        const node = scopeRef.current
        if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
      }, [])

      async function addWorkspace() {
        if (typeof pickDirectory !== 'function') return
        setPicking(true)
        try {
          const picked = await pickDirectory()
          if (typeof picked === 'string' && picked.trim() !== '') {
            await apply('/skills/workspaces', {
              name: skill.name,
              workspaces: skill.workspaces.concat([picked]),
            })
          }
        } catch (error) {
          store.set({ error: message(error) })
        } finally {
          setPicking(false)
        }
      }

      function removeWorkspace(target) {
        return apply('/skills/workspaces', {
          name: skill.name,
          workspaces: skill.workspaces.filter(entry => entry !== target),
        })
      }

      return h(
        'div',
        { className: 'dshskm-scope', id: props.id, ref: scopeRef },
        h(
          'div',
          { className: 'dshskm-scopelabel' },
          skill.workspaces.length === 0 ? t('scopeAll') : t('scopeListed'),
        ),
        h(
          'div',
          { className: 'dshskm-chips' },
          skill.workspaces.map(workspace => h(
            'span',
            { key: workspace, className: 'dshskm-chip', title: workspace },
            h('span', { className: 'dshskm-chiptext' }, shortPath(workspace)),
            h(
              'button',
              {
                type: 'button',
                className: 'dshskm-chipx',
                'aria-label': t('removeWorkspace', { path: workspace }),
                disabled: props.busy === true,
                onClick: () => void removeWorkspace(workspace),
              },
              '×',
            ),
          )),
          typeof pickDirectory === 'function'
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dshskm-add',
                  disabled: picking || props.busy,
                  onClick: () => void addWorkspace(),
                },
                picking ? t('adding') : t('addWorkspace'),
              )
            : null,
        ),
        skill.workspaces.length > 0
          ? h(
              'button',
              {
                type: 'button',
                className: 'dshskm-link',
                disabled: props.busy,
                onClick: () => void apply('/skills/workspaces', { name: skill.name, workspaces: [] }),
              },
              t('clearScope'),
            )
          : null,
      )
    }

    function SkillRow(props) {
      const skill = props.skill
      const [expanded, setExpanded] = React.useState(false)
      const hidden = !skill.enabled || !skill.inScope
      const scopeId = `${PANEL_ID}-scope-${skill.name}`
      const scopeLabel = expanded
        ? t('collapse')
        : skill.workspaces.length === 0
          ? t('scopeAdd')
          : t('scopeButton', { count: skill.workspaces.length })
      return h(
        'div',
        {
          className: 'dshskm-row',
          'data-hidden': hidden ? 'true' : 'false',
          'data-managed': skill.managed ? 'true' : 'false',
        },
        h(
          'div',
          { className: 'dshskm-rowmain' },
          h(
            'div',
            { className: 'dshskm-rowhead' },
            h('span', { className: 'dshskm-name' }, skill.name),
            h(Badge, { skill, tone: hidden ? 'warn' : 'neutral' }),
          ),
          skill.description ? h('div', { className: 'dshskm-desc', title: skill.description }, skill.description) : null,
          hidden && skill.enabled ? h('div', { className: 'dshskm-note' }, t('outside')) : null,
          h(
            'div',
            { className: 'dshskm-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dshskm-link',
                'aria-expanded': expanded ? 'true' : 'false',
                'aria-controls': scopeId,
                onClick: () => setExpanded(!expanded),
              },
              scopeLabel,
            ),
          ),
        ),
        h(Switch, {
          checked: skill.enabled,
          disabled: props.busy,
          label: skill.name,
          onToggle: () => void apply('/skills/enabled', { name: skill.name, enabled: !skill.enabled }),
        }),
        expanded ? h(ScopeEditor, { skill, busy: props.busy, id: scopeId }) : null,
      )
    }


    function Panel() {
      const snapshot = useStore()
      const panelRef = React.useRef(null)

      React.useEffect(() => {
        if (!snapshot.open) return
        const node = panelRef.current
        if (node && typeof node.focus === 'function') node.focus()
      }, [snapshot.open])

      if (!snapshot.open) return null

      const data = snapshot.data
      const skills = data && Array.isArray(data.skills) ? data.skills : []
      let body
      if (!data) body = snapshot.error ? null : h('div', { className: 'dshskm-empty' }, t('loading'))
      else if (skills.length === 0) body = h('div', { className: 'dshskm-empty' }, t('empty'))
      else body = skills.map(skill => h(SkillRow, { key: skill.name, skill, busy: snapshot.busy === skill.name }))

      const subtitle = data ? t('summary', { hidden: data.hidden ?? 0, total: data.total ?? 0 }) : ''

      return h(
        'div',
        {
          className: 'dshskm-backdrop',
          onMouseDown: event => {
            if (event.target === event.currentTarget) closePanel()
          },
        },
        h(
          'div',
          {
            className: 'dshskm-panel',
            id: PANEL_ID,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('title'),
            tabIndex: -1,
            ref: panelRef,
            onKeyDown: event => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                closePanel()
                return
              }
              if (event.key !== 'Tab') return
              const focusable = event.currentTarget.querySelectorAll(
                'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
              )
              if (focusable.length === 0) return
              const first = focusable[0]
              const last = focusable[focusable.length - 1]
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault()
                last.focus()
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault()
                first.focus()
              }
            },
          },
          h(
            'div',
            { className: 'dshskm-head' },
            h(
              'div',
              { className: 'dshskm-headtext' },
              h('div', { className: 'dshskm-title' }, t('title')),
              h('div', { className: 'dshskm-sub' }, subtitle),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dshskm-close',
                title: t('close'),
                'aria-label': t('close'),
                onClick: closePanel,
              },
              icon('close'),
            ),
          ),
          snapshot.error
            ? h(
                'div',
                { className: 'dshskm-error', role: 'alert' },
                h('span', { className: 'dshskm-errortext' }, snapshot.error),
                h('button', { type: 'button', className: 'dshskm-link', onClick: () => void refresh() }, t('retry')),
              )
            : null,
          h('div', { className: 'dshskm-body' }, body),
          h('div', { className: 'dshskm-foot' }, t('footnote')),
        ),
      )
    }

    let pickDirectory = null

    const CSS = `
.dshskm-trigger{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color .12s ease,color .12s ease}
.dshskm-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshskm-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshskm-trigger[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-brand-primary)}
.dshskm-backdrop{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-1);animation:dshskm-fade .12s ease-out}
.dshskm-panel{box-sizing:border-box;display:flex;flex-direction:column;width:min(640px,100%);max-height:min(80vh,780px);overflow:hidden;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.28);font-size:13px;line-height:1.55;font-family:inherit;outline:none}
.dshskm-head{flex:none;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:14px 14px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshskm-headtext{min-width:0}
.dshskm-title{font-size:14px;font-weight:600}
.dshskm-sub{margin-top:2px;font-size:12px;color:var(--dsw-alias-label-secondary)}

.dshskm-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dshskm-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshskm-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshskm-error{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:10px 14px 0;padding:8px 10px;border-radius:8px;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-mask-1);border:1px solid var(--dsw-alias-border-l3);border-left:3px solid var(--dsw-alias-state-error-primary)}
.dshskm-errortext{min-width:0;overflow-wrap:anywhere}
.dshskm-body{flex:1;min-height:0;overflow:auto;padding:6px;display:flex;flex-direction:column;gap:2px}
.dshskm-empty{padding:28px 12px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}
.dshskm-row{box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:12px;row-gap:2px;align-items:start;padding:10px 12px;border-radius:10px}
.dshskm-row + .dshskm-row{border-top:1px solid var(--dsw-alias-border-l1)}
.dshskm-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshskm-row[data-hidden="true"] .dshskm-name{color:var(--dsw-alias-label-secondary)}
.dshskm-rowmain{min-width:0}
.dshskm-rowhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshskm-name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;font-weight:600;overflow-wrap:anywhere}
.dshskm-badge{flex:none;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3);font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshskm-badge[data-tone="warn"]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dshskm-desc{margin-top:3px;font-size:12px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.dshskm-note{margin-top:4px;padding-left:8px;border-left:2px solid var(--dsw-alias-state-warn-primary);font-size:11.5px;color:var(--dsw-alias-label-primary)}
.dshskm-actions{display:flex;align-items:center;gap:12px;margin-top:6px}
.dshskm-link{padding:0;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;cursor:pointer}
.dshskm-link:hover{text-decoration:underline}
.dshskm-link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshskm-link:disabled{opacity:.5;cursor:default;text-decoration:none}
.dshskm-switch{position:relative;flex:none;width:36px;height:21px;margin-top:2px;padding:0;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background-color .15s ease,border-color .15s ease}
.dshskm-switch[data-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dshskm-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshskm-switch:disabled{opacity:.55;cursor:progress}
.dshskm-knob{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:var(--dsw-alias-bg-overlay);box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s ease}
.dshskm-switch[data-checked="true"] .dshskm-knob{transform:translateX(15px);background:var(--dsw-alias-bg-base)}
.dshskm-scope{grid-column:1 / -1;margin-top:8px;padding:10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;align-items:flex-start;gap:8px}
.dshskm-scopelabel{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshskm-chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.dshskm-chip{display:inline-flex;align-items:center;gap:2px;max-width:100%;padding:2px 3px 2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base);font-size:12px}
.dshskm-chiptext{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}
.dshskm-chipx{display:inline-flex;align-items:center;justify-content:center;min-width:22px;min-height:22px;padding:0 3px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:1.2;cursor:pointer}
.dshskm-chipx:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary)}
.dshskm-chipx:disabled{opacity:.5;cursor:progress}
.dshskm-add{padding:3px 10px;border-radius:999px;border:1px dashed var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.dshskm-add:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dshskm-add:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dshskm-add:disabled{opacity:.55;cursor:progress}
.dshskm-foot{flex:none;padding:8px 14px 12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11.5px;color:var(--dsw-alias-label-secondary)}
@media (prefers-reduced-motion:reduce){.dshskm-backdrop,.dshskm-trigger,.dshskm-switch,.dshskm-knob{animation:none;transition:none}}
@keyframes dshskm-fade{from{opacity:0}to{opacity:1}}
`

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          const dispose = ctx.locale.register(NS, { zh: STRINGS.zh, en: STRINGS.en })
          translate = ctx.locale.bind(NS)
          ctx.effect(() => dispose)
        } catch {
          translate = null
        }

        function syncLocale() {
          try {
            const snapshot = typeof ctx.locale.getSnapshot === 'function' ? ctx.locale.getSnapshot() : null
            const active = snapshot && typeof snapshot.active === 'string' ? snapshot.active : 'en'
            locale = active.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
          } catch {
            locale = 'en'
          }
          store.notify()
        }

        syncLocale()
        ctx.effect(() => {
          const unsubscribe = ctx.locale.subscribe(syncLocale)
          return typeof unsubscribe === 'function' ? unsubscribe : () => undefined
        })

        try {
          const workspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
          if (workspace && typeof workspace.pickDirectory === 'function') {
            pickDirectory = () => workspace.pickDirectory()
          }
        } catch {
          pickDirectory = null
        }

        ctx.effect(() => {
          const element = document.createElement('style')
          element.setAttribute('data-dsh-skill-manager', '')
          element.textContent = CSS
          document.head.appendChild(element)
          return () => {
            element.remove()
          }
        })

        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: TRIGGER_ID,
            order: 20,
            label: () => t('open'),
          },
          Trigger,
        ))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: PANEL_ID, order: 20 },
          Panel,
        ))
      },
    }
  },
})
