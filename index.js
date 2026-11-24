/**
 * Skill manager — host half.
 *
 * Manages per-skill availability for the model catalog and the `/` gesture:
 * each skill can be switched off entirely, or limited to a set of workspaces.
 * Enforcement uses the sanctioned same-name shadow: this plugin contributes a
 * higher-priority candidate for a suppressed skill, carrying
 * `invocation: { modelInvocable: false, userInvocable: false }`. The registry's
 * nearest-layer/rank resolution then hides the real skill from the model
 * catalog, from the Client skill list, and from the `skill` tool without
 * touching the skill files on disk.
 *
 * State lives in `<DSH_HOME>/skill-manager/state.json` (per user, profile-wide).
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export const name = 'skill-manager'
export const inject = ['agents', 'skills', 'tools', 'webServer', 'workingDirectory']

const STATE_VERSION = 1
const API_PREFIX = '/skill-manager/api'
const PROVIDER_ID = 'skill-manager'
const MAX_BODY_BYTES = 64 * 1024
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function statePath() {
  const home = process.env.DSH_HOME || path.join(homedir(), '.dsh')
  return path.join(home, 'skill-manager', 'state.json')
}

/** Case-insensitive on Windows; the platform both stores and compares paths. */
function comparable(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function normalizeWorkspaces(input) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (trimmed === '') continue
    const absolute = path.resolve(trimmed)
    if (!out.includes(absolute)) out.push(absolute)
  }
  return out
}

/**
 * Strict form used by every write: an explicit list, absolute paths only, deduplicated.
 * A malformed list is refused instead of being read as "unrestricted".
 */
function requireWorkspaces(input) {
  if (!Array.isArray(input)) throw new Error('workspaces must be an array of absolute directory paths')
  const out = []
  for (const raw of input) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new Error('workspaces must be an array of absolute directory paths')
    }
    const trimmed = raw.trim()
    if (!path.isAbsolute(trimmed)) throw new Error(`workspace "${trimmed}" must be an absolute path`)
    const resolved = path.resolve(trimmed)
    const key = comparable(resolved)
    if (!out.some(existing => comparable(existing) === key)) out.push(resolved)
  }
  return out
}

/** Unrestricted when no workspace is listed; otherwise the session cwd must sit inside one. */
function withinWorkspace(workspaces, cwd) {
  if (workspaces.length === 0) return true
  if (typeof cwd !== 'string' || cwd.trim() === '') return false
  const target = comparable(cwd)
  return workspaces.some(entry => {
    const base = comparable(entry)
    return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep)
  })
}

function suppressed(entry, cwd) {
  if (entry.enabled === false) return true
  return !withinWorkspace(entry.workspaces ?? [], cwd)
}

function emptyState() {
  return { version: STATE_VERSION, skills: {} }
}

function normalizeState(parsed) {
  const state = emptyState()
  if (!parsed || typeof parsed !== 'object') return state
  const skills = parsed.skills
  if (!skills || typeof skills !== 'object') return state
  for (const [rawName, rawEntry] of Object.entries(skills)) {
    if (!SKILL_NAME.test(rawName)) continue
    if (!rawEntry || typeof rawEntry !== 'object') continue
    const entry = { enabled: rawEntry.enabled !== false, workspaces: normalizeWorkspaces(rawEntry.workspaces) }
    if (typeof rawEntry.description === 'string' && rawEntry.description !== '') entry.description = rawEntry.description
    if (typeof rawEntry.source === 'string' && rawEntry.source !== '') entry.source = rawEntry.source
    if (typeof rawEntry.whenToUse === 'string' && rawEntry.whenToUse !== '') entry.whenToUse = rawEntry.whenToUse
    state.skills[rawName] = entry
  }
  return state
}

/**
 * Read the state file. A readable file wins; a missing file is an empty state; an
 * unreadable or malformed file is preserved under a `.corrupt-<ts>` name instead of
 * being silently replaced by the next write.
 */
async function readState(warn) {
  const target = statePath()
  let raw
  try {
    raw = await readFile(target, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') warn?.(`cannot read ${target}: ${error?.message ?? error}`)
    return emptyState()
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  try {
    return normalizeState(JSON.parse(raw))
  } catch (error) {
    const backup = `${target}.corrupt-${Date.now()}`
    try {
      await rename(target, backup)
      warn?.(`${target} was unreadable (${error?.message ?? error}); kept it as ${backup}`)
    } catch {
      warn?.(`${target} is unreadable and could not be moved aside`)
    }
    return emptyState()
  }
}

async function writeState(state) {
  const target = statePath()
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, target)
  } catch (error) {
    try {
      await rm(temporary, { force: true })
    } catch {
      // The temporary file is already gone.
    }
    throw error
  }
}

export async function apply(ctx, config) {
  const warn = reason => {
    try {
      if (ctx && typeof ctx.logger?.warn === 'function') ctx.logger.warn(`skill-manager: ${reason}`)
      else console.warn(`skill-manager: ${reason}`)
    } catch {
      // Logging must never break the plugin.
    }
  }
  const state = await readState(warn)
  /** Skill mutation through the agent tool stays off unless the profile opts in. */
  const allowToolMutations = config?.allowToolMutations === true
  /** One control per contributed layer; every open catalog must recollect after a write. */
  const controls = new Set()
  /** Disposers of the layers this plugin registered into. */
  const scoped = []
  /** Registries already carrying the shadow; an inactive Agent is retried later. */
  const covered = new WeakSet()
  let layers = 0
  let failed = 0
  let failedReason = ''

  function rememberControl(control) {
    if (control && typeof control.invalidate === 'function') controls.add(control)
  }
  /** Serializes state mutations so two rapid clicks cannot interleave a read-modify-write. */
  let queue = Promise.resolve()

  function enqueue(task) {
    const next = queue.then(task, task)
    queue = next.then(() => undefined, () => undefined)
    return next
  }

  function defaultCwd() {
    const directory = ctx.workingDirectory?.defaultDirectory
    return typeof directory === 'string' && directory !== '' ? directory : undefined
  }

  function remember(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  }

  /**
   * The registry a composition reads through: a live Agent's preset may mount its
   * own `skills` scope, and that view also carries preset-level skills the host
   * layer cannot see.
   */
  function registryFor(agent) {
    if (!agent) return ctx.skills
    try {
      const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
      const scoped = presets && typeof presets.serviceFor === 'function' ? presets.serviceFor(agent, 'skills') : undefined
      return scoped ?? ctx.skills
    } catch {
      return ctx.skills
    }
  }

  /**
   * Resolve the catalog view for one call: a live Session Agent when the caller
   * names one, otherwise an explicit cwd, otherwise the default directory.
   */
  async function viewFor(options) {
    const opts = options ?? {}
    let agent
    const sessionId = remember(opts.session)
    if (sessionId !== undefined) {
      try {
        agent = ctx.agents.get(sessionId)
      } catch {
        agent = undefined
      }
    }
    let cwd = remember(opts.cwd)
    if (cwd === undefined && agent !== undefined) {
      try {
        cwd = remember(await ctx.workingDirectory.ensure(agent))
      } catch {
        cwd = undefined
      }
    }
    return { agent, cwd: cwd ?? defaultCwd(), registry: registryFor(agent) }
  }

  /** Forces already-open catalogs to recollect after a visibility change. */
  function invalidate() {
    for (const control of controls) {
      try {
        control.invalidate?.()
      } catch {
        // An inactive registration cannot invalidate; the next listing recollects.
      }
    }
  }

  async function visibleCatalog(view) {
    const summaries = await view.registry.list({ cwd: view.cwd, scope: view.agent })
    const visible = new Map()
    for (const summary of summaries) {
      if (summary.provider === PROVIDER_ID) continue
      visible.set(summary.name, summary)
    }
    return visible
  }

  function rows(view) {
    const current = view ?? { agent: undefined, cwd: defaultCwd(), registry: ctx.skills }
    ensureAgentLayers()
    return visibleCatalog(current).then(visible => {
      let changed = false
      for (const [skillName, entry] of Object.entries(state.skills)) {
        const summary = visible.get(skillName)
        if (!summary) continue
        if (entry.description !== summary.description) {
          entry.description = summary.description
          changed = true
        }
        if (entry.source !== summary.source) {
          entry.source = summary.source
          changed = true
        }
        if (summary.whenToUse !== undefined && entry.whenToUse !== summary.whenToUse) {
          entry.whenToUse = summary.whenToUse
          changed = true
        }
      }
      if (changed) void enqueue(() => writeState(state))

      const names = [...new Set([...visible.keys(), ...Object.keys(state.skills)])].sort()
      const skills = names.map(skillName => {
        const summary = visible.get(skillName)
        const entry = state.skills[skillName]
        const workspaces = entry?.workspaces ?? []
        const enabled = entry?.enabled !== false
        return {
          name: skillName,
          description: entry?.description ?? summary?.description ?? '',
          whenToUse: entry?.whenToUse ?? summary?.whenToUse,
          enabled,
          workspaces: [...workspaces],
          restricted: workspaces.length > 0,
          inScope: withinWorkspace(workspaces, current.cwd),
          managed: entry !== undefined,
          present: summary !== undefined,
          source: summary?.source ?? entry?.source ?? 'unknown',
          modelInvocable: summary?.invocation?.modelInvocable ?? false,
          userInvocable: summary?.invocation?.userInvocable ?? false,
        }
      })
      return {
        ok: true,
        cwd: current.cwd ?? null,
        statePath: statePath(),
        layers,
        failed,
        failedReason: failedReason === '' ? null : failedReason,
        skills,
        hidden: skills.filter(skill => !skill.enabled || !skill.inScope).length,
        total: skills.length,
      }
    })
  }

  async function seedEntry(skillName, view) {
    if (state.skills[skillName]) return state.skills[skillName]
    const visible = await visibleCatalog(view)
    const summary = visible.get(skillName)
    // Only a skill this profile can actually see may gain a state row.
    if (summary === undefined) throw new Error(`unknown skill "${skillName}"`)
    const entry = { enabled: true, workspaces: [] }
    if (summary.description) entry.description = summary.description
    if (summary.source) entry.source = summary.source
    if (summary.whenToUse !== undefined) entry.whenToUse = summary.whenToUse
    state.skills[skillName] = entry
    return entry
  }

  async function setEnabled(skillName, enabled, view) {
    if (typeof skillName !== 'string' || !SKILL_NAME.test(skillName)) {
      throw new Error(`invalid skill name "${String(skillName)}"`)
    }
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean')
    return enqueue(async () => {
      const entry = await seedEntry(skillName, view)
      entry.enabled = enabled
      await writeState(state)
      invalidate()
      const listing = await rows(view)
      const skill = listing.skills.find(candidate => candidate.name === skillName)
      return {
        ok: true,
        text: `Skill manager: "${skillName}" is now ${entry.enabled ? 'enabled' : 'disabled'}.`,
        hidden: listing.hidden,
        total: listing.total,
        skill,
      }
    })
  }

  async function setWorkspaces(skillName, workspaces, view) {
    if (typeof skillName !== 'string' || !SKILL_NAME.test(skillName)) {
      throw new Error(`invalid skill name "${String(skillName)}"`)
    }
    const next = requireWorkspaces(workspaces)
    return enqueue(async () => {
      const entry = await seedEntry(skillName, view)
      entry.workspaces = next
      await writeState(state)
      invalidate()
      const listing = await rows(view)
      const skill = listing.skills.find(candidate => candidate.name === skillName)
      const scope = entry.workspaces.length === 0 ? 'every workspace' : entry.workspaces.join(', ')
      return {
        ok: true,
        text: `Skill manager: "${skillName}" is now available in ${scope}.`,
        hidden: listing.hidden,
        total: listing.total,
        skill,
      }
    })
  }

  /** The same-name shadow this plugin contributes into every layer it can reach. */
  function createShadow(control) {
    rememberControl(control)
    return {
      name: PROVIDER_ID,
      async list(options) {
        const cwd = options?.cwd
        const candidates = []
        for (const [skillName, entry] of Object.entries(state.skills)) {
          if (!suppressed(entry, cwd)) continue
          const candidate = {
            name: skillName,
            description: entry.description ?? `Managed by Skill manager: ${skillName}`,
            invocation: { modelInvocable: false, userInvocable: false },
            source: 'custom',
            provider: PROVIDER_ID,
            rank: 0,
            locator: { plugin: PROVIDER_ID, name: skillName },
          }
          if (entry.whenToUse !== undefined) candidate.whenToUse = entry.whenToUse
          candidates.push(candidate)
        }
        return { candidates, complete: true }
      },
      async get() {
        return undefined
      },
    }
  }

  /**
   * Contribute the shadow into one more layer. A composition that reads its own
   * scope (a preset's `skill-filesystem`) keeps its winning candidates in a nearer
   * layer than this plugin's own, so the host layer alone cannot mask those names;
   * the same shadow therefore also lands in each live Agent's scope. A layer that
   * already carries this registration rejects the duplicate — that is the normal
   * shared-preset case, not a failure.
   */
  function contribute(registry) {
    if (!registry || typeof registry.registerProvider !== 'function') return false
    if (covered.has(registry)) return false
    try {
      const disposer = registry.registerProvider(createShadow)
      if (typeof disposer === 'function') scoped.push(disposer)
      covered.add(registry)
      layers += 1
      return true
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      // A shared preset layer already carries the shadow, and an Agent whose scope is
      // momentarily inactive is retried on the next listing: both are normal.
      if (/already registered|duplicate|inactive context/i.test(text)) return false
      failed += 1
      failedReason = text
      warn(`could not add the shadow to one skill layer: ${text}`)
      return false
    }
  }

  ctx.effect(() => {
    contribute(ctx.skills)
    return () => {
      for (const dispose of scoped.splice(0)) {
        try {
          dispose()
        } catch {
          // The owning layer may already be gone.
        }
      }
    }
  })

  /** Register into one Agent's layer too, so preset-level skills are covered. */
  function contributeAgent(agent) {
    const scope = agent?.ctx ?? agent
    try {
      const registry = scope && typeof scope.get === 'function' ? scope.get('skills') : scope?.skills
      if (registry === undefined || registry === null) return false
      return contribute(registry)
    } catch {
      return false
    }
  }

  /** A session created before this plugin loaded is covered as soon as it is read. */
  function ensureAgentLayers() {
    try {
      for (const agent of ctx.agents.list()) contributeAgent(agent)
    } catch {
      // No agent list at this stage; the creation listener still covers later agents.
    }
  }

  if (typeof ctx.on === 'function') {
    ctx.effect(() => ctx.on('agent/created', function (payload) {
      const agent = payload?.agent ?? payload
      const scope = this && typeof this.get === 'function' ? this : undefined
      try {
        const registry = scope ? scope.get('skills') : agent?.ctx?.skills
        if (registry) contribute(registry)
      } catch {
        // A layer that already carries the shadow rejects the duplicate.
      }
    }))
  }

  ensureAgentLayers()

  function sendJson(response, status, body) {
    const payload = JSON.stringify(body)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
    response.end(payload)
  }

  /**
   * A custom header plus the browser's own origin signals are the mutation gate: a
   * foreign page cannot set the header without a preflight this route never answers,
   * and `Origin` / `Sec-Fetch-Site` catch the remaining cross-origin shapes while
   * still admitting the Desktop shell (whose origin is `dsh-app://`).
   */
  function admitted(request) {
    if (request.headers['x-skill-manager'] !== '1') return false
    const site = request.headers['sec-fetch-site']
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
    const origin = request.headers.origin
    if (typeof origin === 'string' && origin !== '') {
      const host = request.headers.host
      const sameHost = typeof host === 'string' && (origin === `http://${host}` || origin === `https://${host}`)
      if (!sameHost && !origin.startsWith('dsh-app://')) return false
    }
    return true
  }

  async function readBody(request) {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new Error('request body too large')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    const text = Buffer.concat(chunks).toString('utf8')
    if (text.trim() === '') return {}
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request body must be a JSON object')
    return parsed
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    async handler(request, response) {
      const method = request.method ?? 'GET'
      try {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const route = url.pathname.slice(API_PREFIX.length) || '/'
        if (!route.startsWith('/')) {
          sendJson(response, 404, { ok: false, error: 'unknown route' })
          return
        }
        if (route === '/state' || route === '/state/') {
          if (method !== 'GET') {
            sendJson(response, 405, { ok: false, error: 'method not allowed', allow: 'GET' })
            return
          }
          const view = await viewFor({
            cwd: url.searchParams.get('cwd'),
            session: url.searchParams.get('session'),
          })
          sendJson(response, 200, await rows(view))
          return
        }
        if (route === '/skills/enabled' || route === '/skills/workspaces') {
          if (method !== 'POST') {
            sendJson(response, 405, { ok: false, error: 'method not allowed', allow: 'POST' })
            return
          }
          if (!admitted(request)) {
            sendJson(response, 403, { ok: false, error: 'request refused: missing x-skill-manager header' })
            return
          }
          const body = await readBody(request)
          const view = await viewFor({ cwd: body.cwd, session: body.session })
          if (route === '/skills/enabled') {
            const result = await setEnabled(body.name, body.enabled, view)
            sendJson(response, 200, { ...result, listing: await rows(view) })
            return
          }
          const result = await setWorkspaces(body.name, body.workspaces, view)
          sendJson(response, 200, { ...result, listing: await rows(view) })
          return
        }

        sendJson(response, 404, { ok: false, error: `unknown route ${route}` })
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  /** The Agent view a tool call runs in — same recipe `dsh-tool-skill` uses. */
  async function viewFromExec(exec) {
    if (!exec || typeof exec !== 'object') return viewFor({})
    const agent = exec.agent
    const registry = registryFor(agent)
    let cwd = remember(exec.cwd)
    if (cwd === undefined && agent !== undefined) {
      try {
        cwd = remember(await ctx.workingDirectory.ensure(agent, exec.signal))
      } catch {
        cwd = undefined
      }
    }
    return { agent, cwd: cwd ?? defaultCwd(), registry }
  }

  ctx.effect(() => ctx.tools.register({
    name: 'skill_manager',
    description: 'Inspect skill availability. `list` reports every skill with whether it is switched off or limited to workspaces. Changing a skill is the user\'s decision in the Skill manager panel; the mutating actions are refused unless this profile explicitly enables them, so report the finding instead of changing it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'set_enabled', 'set_workspaces'],
          description: 'list reports every skill with its current availability. set_enabled switches one skill off or on. set_workspaces limits one skill to the listed directories; an empty list means every workspace.',
        },
        name: {
          type: 'string',
          description: 'Exact skill name, as reported by list. Required by set_enabled and set_workspaces.',
        },
        enabled: {
          type: 'boolean',
          description: 'set_enabled: true makes the skill available again, false hides it. Defaults to true.',
        },
        workspaces: {
          type: 'array',
          items: { type: 'string' },
          description: 'set_workspaces: absolute directories where the skill stays available. Pass an empty array for every workspace.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render(_args, value) {
        const text = value && typeof value === 'object' && typeof value.text === 'string'
          ? value.text
          : 'Skill manager result unavailable.'
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      const action = typeof input.action === 'string' ? input.action : ''
      const view = await viewFromExec(exec)
      if (action === 'list') {
        const listing = await rows(view)
        const lines = listing.skills.map(skill => {
          const availability = !skill.enabled
            ? 'disabled'
            : skill.inScope ? 'available' : 'out of workspace scope'
          const scope = skill.workspaces.length === 0 ? 'all workspaces' : skill.workspaces.join(', ')
          return `- ${skill.name}: ${availability}; ${scope}; ${skill.description || 'no description'}`
        })
        return {
          ok: true,
          cwd: listing.cwd,
          statePath: listing.statePath,
          layers: listing.layers,
          failed: listing.failed,
          hidden: listing.hidden,
          total: listing.total,
          skills: listing.skills.map(({ name: skillName, enabled, workspaces, inScope, source }) => ({ name: skillName, enabled, workspaces, inScope, source })),
          text: [
            `Skill manager: ${listing.hidden} of ${listing.total} skills are hidden (cwd ${listing.cwd ?? 'unknown'}).`,
            ...lines,
          ].join('\n'),
        }
      }
      if (action === 'set_enabled' || action === 'set_workspaces') {
        // A tool call must never grant a skill the user chose to hide: mutations are
        // opt-in per profile, and the panel route stays the primary path.
        if (!allowToolMutations) {
          throw new Error('this profile keeps skill changes to the Skill manager panel; the tool only reports (`action: "list"`)')
        }
      }
      if (action === 'set_enabled') {
        return setEnabled(input.name, input.enabled === undefined ? true : input.enabled, view)
      }
      if (action === 'set_workspaces') {
        if (!Array.isArray(input.workspaces)) throw new Error('workspaces must be an array of absolute directory paths')
        return setWorkspaces(input.name, input.workspaces, view)
      }
      throw new Error(`unknown action "${action}"; expected list, set_enabled, or set_workspaces`)
    },
  }))
}
