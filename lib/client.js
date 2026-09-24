/**
 * dsh-config-sync — browser half.
 *
 * Renders one settings page (Settings → 配置同步 / Config Sync) and talks to the
 * host half over the same-origin HTTP bridge the host mounts at
 * `/dsh-config-sync/*`. Nothing here touches the filesystem: every action is a
 * request, and every response is a small JSON report.
 *
 * Delivered as a `dsh.client` bundle: the host's client-modules service scans
 * packages declaring `dsh.client.platform = "web"`, serves `exports["./client"]`
 * and calls `apply()`. `require` resolves the shared React runtime.
 */
window.__ModuleLoader__.load({
  id: 'dsh-config-sync',
  factory: (require) => {
    // This factory runs as a plain function in the browser — there is no
    // CommonJS wrapper around it, so `exports` and `module` must be created
    // here. Omitting these two lines fails at plugin-boot time with
    // "exports is not defined", which aborts the whole plugin table's load.
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')
    const React = react.default ?? react

    /** Bridge prefix, matching the host half. */
    const BRIDGE = '/dsh-config-sync'

    // -----------------------------------------------------------------------
    // styles — theme tokens only, so light/dark both work
    // -----------------------------------------------------------------------
    const css = [
      '.dscs-root{display:flex;flex-direction:column;gap:14px;padding:2px 0 24px;max-width:820px}',
      '.dscs-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:14px 16px}',
      '.dscs-h{display:flex;align-items:center;gap:10px;margin:0 0 4px;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dscs-sub{margin:0 0 12px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
      '.dscs-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid var(--dsw-alias-border-l2)}',
      '.dscs-row:first-of-type{border-top:none}',
      '.dscs-label{font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.dscs-hint{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-tertiary);margin-top:2px}',
      '.dscs-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
      '.dscs-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.dscs-btn{font:inherit;font-size:12.5px;font-weight:600;line-height:1;cursor:pointer;padding:8px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);transition:background-color .13s,border-color .13s}',
      '.dscs-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-interactive-bg-hover-accent)}',
      '.dscs-btn:disabled{opacity:.5;cursor:default}',
      '.dscs-btnPrimary{background:var(--dsw-alias-button-info-fill);border-color:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.dscs-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover);border-color:var(--dsw-alias-button-info-hover)}',
      '.dscs-pill{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;line-height:1;padding:4px 9px;border-radius:999px;white-space:nowrap}',
      '.dscs-pillOk{color:#7ddb9c;background:rgba(80,200,120,.13);border:1px solid rgba(80,200,120,.3)}',
      '.dscs-pillWarn{color:var(--dsw-alias-state-warn-primary);background:rgba(240,170,80,.12);border:1px solid rgba(240,170,80,.3)}',
      '.dscs-pillErr{color:var(--dsw-alias-state-error-primary);background:rgba(240,90,90,.12);border:1px solid rgba(240,90,90,.3)}',
      '.dscs-pillDim{color:var(--dsw-alias-label-tertiary);background:transparent;border:1px solid var(--dsw-alias-border-l2)}',
      '.dscs-select,.dscs-input{font:inherit;font-size:12.5px;padding:7px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary)}',
      '.dscs-input{min-width:240px}',
      '.dscs-pre{margin:10px 0 0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:280px;overflow:auto}',
      '.dscs-switch{position:relative;display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none}',
      '.dscs-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:12px}',
      '.dscs-k{color:var(--dsw-alias-label-tertiary)}',
      '.dscs-v{color:var(--dsw-alias-label-secondary);word-break:break-all}',
    ].join('')

    const CSS_TAG = 'dsh-config-sync/section.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-config-sync'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // -----------------------------------------------------------------------
    // bridge
    // -----------------------------------------------------------------------
    /** GET a bridge route; returns `{ ok, ... }` and never throws. */
    async function get(route) {
      try {
        const response = await fetch(`${BRIDGE}${route}`, { headers: { accept: 'application/json' } })
        return await response.json()
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    /** POST a bridge route with a JSON body; never throws. */
    async function post(route, body) {
      try {
        const response = await fetch(`${BRIDGE}${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body ?? {}),
        })
        return await response.json()
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }

    // -----------------------------------------------------------------------
    // presentation helpers
    // -----------------------------------------------------------------------
    const t = (zh, en, lang) => (lang === 'en' ? en : zh)

    /** Format an epoch-millisecond value for display. */
    const when = (ms) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toLocaleString() : '—')

    /** Human label for one auto-sync interval id. */
    const intervalLabel = (id) =>
      ({ '15m': '15 min', '30m': '30 min', '1h': '1 h', '6h': '6 h', '24h': '24 h' })[id] ?? id

    /** A small status pill. */
    const Pill = ({ tone, children }) =>
      React.createElement('span', { className: `dscs-pill dscs-pill${tone}` }, children)

    // -----------------------------------------------------------------------
    // main section
    // -----------------------------------------------------------------------
    function ConfigSyncSection() {
      const [lang, setLang] = React.useState('zh')
      const [data, setData] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [log, setLog] = React.useState('')
      const [error, setError] = React.useState('')
      const [token, setToken] = React.useState('')
      const [showToken, setShowToken] = React.useState(false)

      const refresh = React.useCallback(async () => {
        const result = await get('/status')
        if (result.ok === true) {
          setData(result)
          setError('')
        } else {
          setError(result.error ?? 'status unavailable')
        }
      }, [])

      React.useEffect(() => {
        void refresh()
      }, [refresh])

      /** Run one bridge action with busy state and a textual report. */
      const run = React.useCallback(
        async (tag, route, body) => {
          setBusy(tag)
          setError('')
          setLog('')
          const result = await post(route, body)
          if (result.ok !== true) {
            setError(result.error ?? `${tag} failed`)
          } else {
            const lines = []
            if (result.written) lines.push(`snapshot: ${result.written.length} file(s) written`)
            if (Array.isArray(result.changed) && result.changed.length) lines.push(`changed: ${result.changed.join(', ')}`)
            if (Array.isArray(result.added) && result.added.length) lines.push(`new: ${result.added.join(', ')}`)
            if (Array.isArray(result.removed) && result.removed.length) lines.push(`removed: ${result.removed.join(', ')}`)
            if (result.git) lines.push(`git: ${result.git.message ?? (result.git.committed ? 'committed' : 'no change')}`)
            if (result.applied) lines.push(`applied: ${result.applied.length} file(s)`)
            if (result.backupDir) lines.push(`backup: ${result.backupDir}`)
            if (result.nextStep) lines.push(`next: ${result.nextStep}`)
            if (result.actions) lines.push(...result.actions.map((a) => `${a.action}: ${a.path}`))
            setLog(lines.join('\n') || 'done')
          }
          setBusy('')
          await refresh()
        },
        [refresh],
      )

      /** Persist one settings patch. */
      const save = React.useCallback(
        async (patch) => {
          const result = await post('/settings', patch)
          if (result.ok !== true) setError(result.error ?? 'saving settings failed')
          await refresh()
        },
        [refresh],
      )

      if (data === null) {
        return React.createElement(
          'div',
          { className: 'dscs-root' },
          React.createElement('div', { className: 'dscs-card' }, error === '' ? '…' : error),
        )
      }

      const s = data.settings ?? {}
      const git = data.git ?? {}
      const changes = data.changes
      const pending = changes ? changes.changed.length + changes.added.length + changes.removed.length : 0
      const tokenInfo = data.hasGithubToken ?? {}

      return React.createElement(
        'div',
        { className: 'dscs-root' },

        // ---- status -------------------------------------------------------
        React.createElement(
          'div',
          { className: 'dscs-card' },
          React.createElement(
            'div',
            { className: 'dscs-h' },
            t('配置同步', 'Config Sync', lang),
            React.createElement('span', { style: { flex: 1 } }),
            pending === 0
              ? React.createElement(Pill, { tone: 'Ok' }, t('已同步', 'in sync', lang))
              : React.createElement(Pill, { tone: 'Warn' }, `${pending} ${t('项待同步', 'pending', lang)}`),
          ),
          React.createElement(
            'p',
            { className: 'dscs-sub' },
            t(
              '只同步“配方”：settings.yaml、插件清单、cordis 覆盖层、pnpm 配置与锁定文件。node_modules（313 MB）与凭据默认不参与，换机器后用 dsh plugin install 重建依赖树。',
              'Syncs the recipe only: settings.yaml, the plugin manifest, cordis patch layers and pnpm config/lockfile. node_modules (313 MB) and credentials stay out; rebuild on the other machine with dsh plugin install.',
              lang,
            ),
          ),
          React.createElement(
            'div',
            { className: 'dscs-kv' },
            React.createElement('div', { className: 'dscs-k' }, t('同步目录', 'Sync root', lang)),
            React.createElement('div', { className: 'dscs-v dscs-mono' }, data.syncRoot ?? '—'),
            React.createElement('div', { className: 'dscs-k' }, 'Profile'),
            React.createElement('div', { className: 'dscs-v' }, `${data.profile ?? '—'} (${data.profileReason ?? ''})`),
            React.createElement('div', { className: 'dscs-k' }, t('快照', 'Snapshot', lang)),
            React.createElement(
              'div',
              { className: 'dscs-v' },
              `${(data.snapshot?.files ?? []).length} file(s)` +
                (data.snapshot?.at ? ` · ${when(Date.parse(data.snapshot.at))}` : '') +
                (data.snapshot?.secretsIncluded ? ` · ${t('含凭据', 'includes secrets', lang)}` : ''),
            ),
            React.createElement('div', { className: 'dscs-k' }, 'Git'),
            React.createElement(
              'div',
              { className: 'dscs-v' },
              git.available
                ? git.isRepo
                  ? `${git.branch}${git.hasRemote ? ` → ${git.remote}` : ` · ${t('无远端', 'no remote', lang)}`}` +
                    (git.dirty ? ` · ${t('有未提交改动', 'uncommitted', lang)}` : '') +
                    (git.ahead ? ` · ${git.ahead} ↑` : '') +
                    (git.behind ? ` · ${git.behind} ↓` : '')
                  : t('不是 git 仓库（仅本地快照）', 'not a git repo (local snapshot only)', lang)
                : t('未检测到 git', 'git not found', lang),
            ),
            git.lastCommit
              ? React.createElement('div', { className: 'dscs-k' }, t('最近提交', 'Last commit'))
              : null,
            git.lastCommit ? React.createElement('div', { className: 'dscs-v dscs-mono' }, git.lastCommit) : null,
            React.createElement('div', { className: 'dscs-k' }, 'GitHub'),
            React.createElement(
              'div',
              { className: 'dscs-v' },
              tokenInfo.available
                ? `${t('凭据可用', 'credential available', lang)} (${tokenInfo.source}${tokenInfo.login ? ` · ${tokenInfo.login}` : ''})`
                : t('未检测到凭据', 'no credential detected', lang),
            ),
          ),
        ),

        // ---- actions ------------------------------------------------------
        React.createElement(
          'div',
          { className: 'dscs-card' },
          React.createElement('div', { className: 'dscs-h' }, t('手动同步', 'Manual sync', lang)),
          React.createElement(
            'p',
            { className: 'dscs-sub' },
            t(
              '推送 = 把本机配置写进同步目录并提交/推送；拉取 = 从远端取回并写回本机（先自动备份）。',
              'Push writes this machine into the sync root and commits/pushes; Pull fetches and applies (after an automatic backup).',
              lang,
            ),
          ),
          React.createElement(
            'div',
            { className: 'dscs-actions' },
            React.createElement(
              'button',
              {
                className: 'dscs-btn dscs-btnPrimary',
                disabled: busy !== '',
                onClick: () => void run('push', '/push', { git: true, push: true }),
              },
              busy === 'push' ? t('推送中…', 'Pushing…', lang) : t('立即推送', 'Push now', lang),
            ),
            React.createElement(
              'button',
              { className: 'dscs-btn', disabled: busy !== '', onClick: () => void run('pushdry', '/push', { dryRun: true }) },
              busy === 'pushdry' ? '…' : t('预览改动', 'Preview changes', lang),
            ),
            React.createElement(
              'button',
              { className: 'dscs-btn', disabled: busy !== '', onClick: () => void run('pull', '/pull', { confirm: false }) },
              busy === 'pull' ? '…' : t('拉取预览', 'Preview pull', lang),
            ),
            React.createElement(
              'button',
              {
                className: 'dscs-btn',
                disabled: busy !== '',
                onClick: () => {
                  if (typeof window !== 'undefined' && window.confirm && !window.confirm(t('将覆盖本机配置（会先自动备份）。继续？', 'This overwrites your local config (after an automatic backup). Continue?', lang))) return
                  void run('pullgo', '/pull', { confirm: true, git: true })
                },
              },
              busy === 'pullgo' ? t('拉取中…', 'Pulling…', lang) : t('立即拉取', 'Pull now', lang),
            ),
            React.createElement(
              'button',
              { className: 'dscs-btn', disabled: busy !== '', onClick: () => void refresh() },
              t('刷新', 'Refresh', lang),
            ),
          ),
          log !== '' ? React.createElement('pre', { className: 'dscs-pre' }, log) : null,
          error !== '' ? React.createElement('pre', { className: 'dscs-pre' }, `error: ${error}`) : null,
        ),

        // ---- auto sync ----------------------------------------------------
        React.createElement(
          'div',
          { className: 'dscs-card' },
          React.createElement('div', { className: 'dscs-h' }, t('自动同步', 'Automatic sync', lang)),
          React.createElement(
            'p',
            { className: 'dscs-sub' },
            t(
              '宿主每分钟检查一次，到达所选间隔才真正执行。设置随快照一起同步，所以另一台机器会沿用同一节奏。',
              'The host wakes every minute and acts only when the chosen interval has elapsed. Settings travel with the snapshot, so other machines inherit the same cadence.',
              lang,
            ),
          ),
          React.createElement(
            'div',
            { className: 'dscs-row' },
            React.createElement(
              'div',
              null,
              React.createElement('div', { className: 'dscs-label' }, t('启用自动同步', 'Enable auto sync', lang)),
              React.createElement(
                'div',
                { className: 'dscs-hint' },
                data.lastAutoSyncAt
                  ? `${t('上次执行', 'last run', lang)}: ${when(data.lastAutoSyncAt)}`
                  : t('尚未执行过', 'never run yet', lang),
              ),
            ),
            React.createElement('input', {
              type: 'checkbox',
              checked: s.autoSync === true,
              onChange: (event) => void save({ autoSync: event.target.checked }),
            }),
          ),
          React.createElement(
            'div',
            { className: 'dscs-row' },
            React.createElement('div', { className: 'dscs-label' }, t('间隔', 'Interval', lang)),
            React.createElement(
              'select',
              {
                className: 'dscs-select',
                value: s.autoSyncInterval ?? '1h',
                disabled: s.autoSync !== true,
                onChange: (event) => void save({ autoSyncInterval: event.target.value }),
              },
              (data.intervals ?? []).map((id) =>
                React.createElement('option', { key: id, value: id }, intervalLabel(id)),
              ),
            ),
          ),
          React.createElement(
            'div',
            { className: 'dscs-row' },
            React.createElement('div', { className: 'dscs-label' }, t('方向', 'Direction', lang)),
            React.createElement(
              'select',
              {
                className: 'dscs-select',
                value: s.autoSyncDirection ?? 'push',
                disabled: s.autoSync !== true,
                onChange: (event) => void save({ autoSyncDirection: event.target.value }),
              },
              React.createElement('option', { value: 'push' }, t('推送本机 → 远端', 'Push this machine → remote', lang)),
              React.createElement('option', { value: 'pull' }, t('拉取远端 → 本机', 'Pull remote → this machine', lang)),
            ),
          ),
          React.createElement(
            'div',
            { className: 'dscs-row' },
            React.createElement(
              'div',
              null,
              React.createElement('div', { className: 'dscs-label' }, t('同时执行 git 提交/推送', 'Also commit/push with git', lang)),
              React.createElement(
                'div',
                { className: 'dscs-hint' },
                t('关闭后只更新本地快照目录，不碰 git。', 'Off means only the local snapshot folder updates; git is untouched.', lang),
              ),
            ),
            React.createElement('input', {
              type: 'checkbox',
              checked: s.autoSyncRunGit !== false,
              disabled: s.autoSync !== true,
              onChange: (event) => void save({ autoSyncRunGit: event.target.checked }),
            }),
          ),
          data.autoSyncState
            ? React.createElement(
                'pre',
                { className: 'dscs-pre' },
                `${data.autoSyncState.at ?? ''} · ${data.autoSyncState.direction ?? ''} · ${
                  data.autoSyncState.ok === true ? 'ok' : 'failed'
                }${data.autoSyncState.detail ? ` — ${data.autoSyncState.detail}` : ''}`,
              )
            : null,
        ),

        // ---- github bootstrap ---------------------------------------------
        React.createElement(
          'div',
          { className: 'dscs-card' },
          React.createElement('div', { className: 'dscs-h' }, t('云端私有仓库', 'Private cloud repository', lang)),
          React.createElement(
            'p',
            { className: 'dscs-sub' },
            tokenInfo.available
              ? t(
                  '检测到可用凭据，可直接一键创建私有仓库并把当前快照推上去。',
                  'A credential is available: create a private repository and push the current snapshot in one click.',
                  lang,
                )
              : t(
                  '未检测到 GitHub 凭据。可粘贴一个具备 repo 权限的 token（只在本次请求中使用，不写入磁盘、不回显）。',
                  'No GitHub credential detected. Paste a token with repo scope (used for this request only; never written to disk or echoed back).',
                  lang,
                ),
          ),
          React.createElement(
            'div',
            { className: 'dscs-actions' },
            tokenInfo.available
              ? React.createElement(
                  'button',
                  {
                    className: 'dscs-btn dscs-btnPrimary',
                    disabled: busy !== '',
                    onClick: () => void run('ghcreate', '/github', {}),
                  },
                  busy === 'ghcreate'
                    ? t('创建中…', 'Creating…', lang)
                    : t('创建私有仓库并推送', 'Create private repo and push', lang),
                )
              : null,
            React.createElement(
              'button',
              { className: 'dscs-btn', onClick: () => setShowToken(!showToken) },
              showToken ? t('收起 token 输入', 'Hide token input', lang) : t('使用 token', 'Use a token', lang),
            ),
          ),
          showToken
            ? React.createElement(
                'div',
                { className: 'dscs-actions', style: { marginTop: 10 } },
                React.createElement('input', {
                  className: 'dscs-input',
                  type: 'password',
                  placeholder: 'ghp_… / github_pat_…',
                  value: token,
                  onChange: (event) => setToken(event.target.value),
                }),
                React.createElement(
                  'button',
                  {
                    className: 'dscs-btn',
                    disabled: busy !== '' || token.trim() === '',
                    onClick: async () => {
                      await run('ghtoken', '/github', { token: token.trim() })
                      setToken('')
                    },
                  },
                  busy === 'ghtoken' ? '…' : t('创建并推送', 'Create and push', lang),
                ),
              )
            : null,
          React.createElement(
            'div',
            { className: 'dscs-hint' },
            t(
              '凭据永不同步：.credentials.yaml 默认排除，且 .gitignore 另有一道兜底。',
              'Credentials never sync: .credentials.yaml is excluded by default and additionally .gitignore’d.',
              lang,
            ),
          ),
        ),

        // ---- language -----------------------------------------------------
        React.createElement(
          'div',
          { className: 'dscs-actions' },
          React.createElement(
            'button',
            { className: 'dscs-btn', onClick: () => setLang(lang === 'zh' ? 'en' : 'zh') },
            lang === 'zh' ? 'English' : '中文',
          ),
        ),
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      // Same shape as the shipped section registrants (e.g. dsh-plugin-
      // subscriptions): a plain `slots.inject(name, () => slots.register(...))`.
      // A generator callback is also supported, but is not required — this
      // plugin does not need one.
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'config-sync',
                order: 55,
                label: () => '配置同步',
              },
              ConfigSyncSection,
            ),
          ),
        'config-sync: settings section',
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
