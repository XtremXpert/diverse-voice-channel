/**
 * Phone channel: expose one HTTP route that feeds spoken text into a long-lived
 * Harness agent and returns the assistant reply for text-to-speech playback.
 *
 * The phone bridge posts `{ "text": "..." }` and receives `{ "reply": "..." }`.
 */

/** Loader plugin name. */
export const name = 'phone-channel'

/** Services this plugin needs before it can register its route. */
export const inject = ['webServer', 'agents', 'agentPresets', 'agentDefaultModel', 'credentials']

const SESSION_ID = 'phone-channel'

/**
 * Read one bounded JSON body.
 * @param req - incoming request owned by the handler.
 * @returns parsed object, or an empty object when the body is unusable.
 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Register the phone route and drive one agent turn per request.
 * @param ctx - host context owning the web server and agent registry.
 * @param config - optional `path` and `cwd` overrides.
 */
export function apply(ctx, config = {}) {
  const path = config.path ?? '/phone/ask'
  const cwd = config.cwd ?? process.cwd()
  let handle
  let queue = Promise.resolve()

  const ensureAgent = async () => {
    if (handle !== undefined) return handle
    const selection = ctx.agentDefaultModel.currentSelection()
    // With DEEPSEEK_API_KEY in the launch environment the API-key route authenticates directly.
    const accountSelection = { provider: selection.provider, model: selection.model }
    ctx.logger.info(`phone channel: model selection ${JSON.stringify(selection ?? null)}`)
    const options = {
      sessionId: SESSION_ID,
      meta: { cwd, agentPreset: ctx.agentPresets.defaultId },
      agentOptions: accountSelection,
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx)
      },
    }
    try {
      handle = await ctx.agents.create(options)
    } catch (first) {
      // A restarted Harness still has the previous phone session on disk.
      ctx.logger.info('phone channel: create failed, resuming', first?.message ?? first)
      try {
        handle = await ctx.agents.resume(options)
      } catch (second) {
        ctx.logger.warn('phone channel: resume failed, starting a fresh session', second?.message ?? second)
        handle = await ctx.agents.create({ ...options, sessionId: `${SESSION_ID}-${Date.now()}` })
      }
    }
    ctx.logger.info('phone channel: agent ready')
    return handle
  }

  const ask = async (text) => {
    const active = await ensureAgent()
    const parts = []
    const types = new Set()
    const sessionId = active.agent.session.id
    let lastError = ''
    const disposeEvent = ctx.on('session/event', (session, event) => {
      if (session.id !== sessionId) return
      types.add(`session:${event.type}`)
      if (event.type === 'llm/retry') {
        lastError = `RETRY ${JSON.stringify(event.data ?? {}).slice(0, 1200)}`
      }
      if (event.type === 'assistant/attempt') {
        lastError = `ATTEMPT ${JSON.stringify(event.data ?? {}).slice(0, 2000)}`
      }
      if (event.type !== 'assistant/message') return
      const content = event.data?.message?.content
      if (typeof content === 'string') { parts.push(content); return }
      for (const part of content ?? []) {
        if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text)
      }
    })
    let failure
    try {
      active.agent.followup({ content: [{ type: 'text', text }], source: { kind: 'phone' } })
      await active.agent.whenIdle()
    } catch (error) {
      failure = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
    } finally {
      disposeEvent()
    }
    const reply = parts.join(' ').replace(/\s+/gu, ' ').trim()
    ctx.logger.info(`phone channel: events=${[...types].join(',')} reply=${reply.slice(0, 80)}`)
    return { reply, events: [...types], failure, selection: active.agent.options ?? null, lastError }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/phone/ping',
    handler: async (_req, res) => {
      const report = {}
      for (const url of ['https://api.deepseek.com/', 'https://api.deepseek.com/v1/models']) {
        const started = Date.now()
        try {
          const response = await fetch(url, { method: 'GET' })
          report[url] = { status: response.status, ms: Date.now() - started }
        } catch (error) {
          report[url] = { error: error?.message ?? String(error), cause: String(error?.cause ?? ''), ms: Date.now() - started }
        }
      }
      try {
        const account = ctx.get('deepseekAccount')
        report.account = account === undefined ? 'missing' : 'present'
        if (account !== undefined) {
          report.tokens = {}
          for (const url of ['https://api.deepseek.com', 'https://chat.deepseek.com', 'https://platform.deepseek.com', 'https://api.deepseek.com/messages']) {
            try {
              const token = await account.resolveToken(url)
              report.tokens[url] = token === undefined ? 'none' : `token(${String(token).slice(0, 6)}...)`
            } catch (error) { report.tokens[url] = `error: ${error?.message ?? error}` }
          }
        }
      } catch (error) {
        report.accountError = error?.message ?? String(error)
      }
      try {
        const credentials = ctx.get('credentials')
        report.credentials = credentials === undefined ? 'missing' : 'present'
        if (credentials !== undefined) {
          const records = await credentials.listRecords()
          report.records = records.map((row) => ({
            subject: row.subject ?? row.key ?? row.name ?? 'unknown',
            kind: row.kind ?? null,
          }))
        }
      } catch (error) {
        report.credentialsError = error?.message ?? String(error)
      }
      const body = JSON.stringify(report)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(body)
    },
  }))
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      const send = (status, payload) => {
        const body = JSON.stringify(payload)
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
        res.end(body)
      }
      if (req.method !== 'POST') { send(405, { error: 'POST only' }); return }
      try {
        const body = await readJson(req)
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (text === '') { send(400, { error: 'text is required' }); return }
        // One turn at a time: a phone call is a single conversation.
        const run = queue.then(async () => await ask(text))
        queue = run.catch(() => undefined)
        send(200, await run)
      } catch (error) {
        ctx.logger.warn('phone channel: request failed', error)
        send(500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))
}
