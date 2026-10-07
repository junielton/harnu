import { createServer, type Server } from 'node:http'

/**
 * A scripted stand-in for the Anthropic Messages API (T389 P1W5 L4): a loopback HTTP server that
 * answers `POST /v1/messages` as a server-sent stream, so a real `claude -p` runs real turns with
 * a fake key, no login and no cost. The launcher points the CLI at it with `ANTHROPIC_BASE_URL`.
 * It never sees a real credential and never forwards anything.
 */

export type Reply =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: Record<string, unknown>; id?: string }
  | { kind: 'error'; status: number; type: string; message: string }

export interface ApiRequest {
  n: number
  path: string
  /** The parsed JSON body of a `/v1/messages` request. */
  body: {
    model?: string
    system?: unknown
    messages?: { role: string; content: unknown }[]
    tools?: { name: string }[]
  }
  /** The text of the last user message, tool results included, flattened. Never logged. */
  lastUserText: string
  atMs: number
}

export type ApiScript = (req: ApiRequest) => Reply

export interface FakeApi {
  url: string
  requests: ApiRequest[]
  stop(): Promise<void>
}

function flatten(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => {
      const b = c as { type?: string; text?: string; content?: unknown }
      if (b.type === 'text') return b.text ?? ''
      if (b.type === 'tool_result') return flatten(b.content)
      return ''
    })
    .join('\n')
}

const sse = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

function stream(reply: Exclude<Reply, { kind: 'error' }>, model: string): string {
  const start = sse('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 }
    }
  })
  if (reply.kind === 'text') {
    return (
      start +
      sse('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      }) +
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: reply.text }
      }) +
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 5 }
      }) +
      sse('message_stop', { type: 'message_stop' })
    )
  }
  return (
    start +
    sse('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: reply.id ?? 'toolu_fake01',
        name: reply.name,
        input: {}
      }
    }) +
    sse('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.input) }
    }) +
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 20 }
    }) +
    sse('message_stop', { type: 'message_stop' })
  )
}

export async function startFakeApi(script: ApiScript): Promise<FakeApi> {
  const requests: ApiRequest[] = []
  const started = Date.now()
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      if (req.method !== 'POST' || !path.endsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ input_tokens: 10 }))
        return
      }
      let body: ApiRequest['body'] = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        // a malformed body is answered like any other
      }
      const msgs = body.messages ?? []
      const last = [...msgs].reverse().find((m) => m.role === 'user')
      const apiReq: ApiRequest = {
        n: requests.length + 1,
        path,
        body,
        lastUserText: flatten(last?.content),
        atMs: Date.now() - started
      }
      requests.push(apiReq)
      const reply = script(apiReq)
      if (reply.kind === 'error') {
        res.writeHead(reply.status, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({ type: 'error', error: { type: reply.type, message: reply.message } })
        )
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.end(stream(reply, body.model ?? 'claude-haiku-4-5'))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('fake api: no port')
  return {
    url: `http://127.0.0.1:${addr.port}`,
    requests,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
