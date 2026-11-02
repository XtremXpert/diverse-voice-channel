/** DSH voice bridge: AudioSocket server with local Piper TTS, DTMF confirmation and call capture. */
import { createServer as createHttpServer } from 'node:http'
import { createServer, connect } from 'node:net'
import { createRequire } from 'node:module'
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'

const VOICES = {
  siwis: { repo: 'csukuangfj/vits-piper-fr_FR-siwis-medium', revision: '6b956227093bc8f9c05e5549508c4a510e97ef26', model: 'fr_FR-siwis-medium.onnx' },
  upmc: { repo: 'csukuangfj/vits-piper-fr_FR-upmc-medium', revision: '282bacef30b429ca30676bdd0eec155ea8d1b402', model: 'fr_FR-upmc-medium.onnx' },
}
const VOICE = process.env.PIPER_VOICE ?? 'upmc'
const { repo: REPO, revision: REVISION, model: MODEL_FILE } = VOICES[VOICE] ?? VOICES.upmc
const ROOT = process.env.MODELS_DIR ? `${process.env.MODELS_DIR}/${VOICE}` : `/models/piper/${VOICE}`
const PORT = Number(process.env.AUDIOSOCKET_PORT ?? 9019)
const HEALTH = Number(process.env.HEALTH_PORT ?? 9020)
const ANNOUNCEMENT = process.env.GREETING ?? 'Bonjour. Parlez après le bip. Tapez 99 dièse pour confirmer.'
const CONFIRMATION = process.env.CONFIRMATION ?? 'Tâche confirmée. Merci et à bientôt.'
const GREETING_DELAY_MS = Number(process.env.GREETING_DELAY_MS ?? 6000)
/** This Asterisk build accepts only 8 kHz slin from the server (0x12 is rejected), so we resample. */
const RATE = 8000
const FRAME_SAMPLES = RATE / 50
const FRAME_TYPE = 0x10

async function download(url, destination) {
  if (existsSync(destination)) return
  const response = await fetch(url)
  if (!response.ok) throw new Error(`download ${url} failed: ${response.status}`)
  mkdirSync(join(destination, '..'), { recursive: true })
  await pipeline(response.body, createWriteStream(destination))
}

async function ensureModels() {
  mkdirSync(join(ROOT, 'espeak-ng-data'), { recursive: true })
  for (const name of [MODEL_FILE, 'tokens.txt']) {
    await download(`https://huggingface.co/${REPO}/resolve/${REVISION}/${name}`, join(ROOT, name))
  }
  const listing = await (await fetch(`https://huggingface.co/api/models/${REPO}/tree/${REVISION}/espeak-ng-data?recursive=true&limit=1000`)).json()
  const files = listing.filter(entry => entry.type === 'file')
  if (files.length < 100) throw new Error(`espeak-ng-data listing looks incomplete: ${files.length} files`)
  for (const entry of files) {
    await download(`https://huggingface.co/${REPO}/resolve/${REVISION}/${entry.path}`, join(ROOT, entry.path))
  }
  const asr = '/models/whisper-base'
  mkdirSync(asr, { recursive: true })
  const whisperRevision = 'bb53ee204431c90d314c1cc08d28d23e5b7927cc'
  for (const name of ['base-encoder.int8.onnx', 'base-decoder.int8.onnx', 'base-tokens.txt']) {
    await download(`https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base/resolve/${whisperRevision}/${name}`, join(asr, name))
  }
  console.log(`models ready in ${ROOT} and ${asr}`)
}

function resample(samples, from, to) {
  if (from === to) return samples
  const ratio = to / from
  const cutoff = Math.min(0.5, ratio * 0.5) * 0.94
  const taps = 48, half = taps / 2
  const out = new Float32Array(Math.floor(samples.length * ratio))
  for (let i = 0; i < out.length; i++) {
    const position = i / ratio
    const base = Math.floor(position)
    let sum = 0
    for (let k = 0; k < taps; k++) {
      const index = base - half + 1 + k
      const distance = position - index
      const x = distance * 2 * cutoff
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * (k + 0.5)) / taps)
      sum += (samples[index] ?? 0) * sinc * window
    }
    out[i] = sum * 2 * cutoff
  }
  return out
}

function toPcm16(samples) {
  const pcm = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2)
  return pcm
}

/**
 * Join captured frames into one sample buffer.
 * @param frames - Float32 frames in capture order.
 * @returns the concatenated samples.
 */
function concatSamples(frames) {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const frame of frames) { out.set(frame, offset); offset += frame.length }
  return out
}

function wav(pcm, rate) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8); header.write('fmt ', 12)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

await ensureModels()
const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')
const tts = new sherpa.OfflineTts({
  model: { vits: { model: join(ROOT, MODEL_FILE), tokens: join(ROOT, 'tokens.txt'),
    dataDir: join(ROOT, 'espeak-ng-data'), lengthScale: 1 }, numThreads: 2, provider: 'cpu', debug: 0 },
  maxNumSentences: 1, numThreads: 2, provider: 'cpu',
})
console.log(`piper loaded sr=${tts.sampleRate} voice=${VOICE}`)

const ASR = '/models/whisper-base'
const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { whisper: { encoder: join(ASR, 'base-encoder.int8.onnx'), decoder: join(ASR, 'base-decoder.int8.onnx'),
    language: 'fr', task: 'transcribe', tailPaddings: -1 }, tokens: join(ASR, 'base-tokens.txt'),
    numThreads: 4, provider: 'cpu', debug: 0 },
})
console.log('whisper loaded')

/**
 * Recognize one 8 kHz telephone utterance.
 * @param pcm8k - accumulated slin 8 kHz samples.
 * @returns recognized French text.
 */
/**
 * Ask the language model for one spoken answer.
 * @param text - what the caller said.
 * @returns the reply text, or an empty string when unavailable.
 */
async function answer(text) {
  if (AGENT_URL !== '') {
    try {
      const response = await fetch(AGENT_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (response.ok) {
        const body = await response.json()
        const reply = String(body?.reply ?? '').trim()
        if (reply !== '') return reply
      } else {
        console.log(`agent http ${response.status}`)
      }
    } catch (error) {
      console.log(`agent unreachable: ${error.message}`)
    }
  }
  if (CHAT_KEY === '') return ''
  try {
    const response = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CHAT_KEY}` },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [{ role: 'system', content: CHAT_SYSTEM }, { role: 'user', content: text }],
        max_tokens: 220,
        temperature: 0.4,
      }),
    })
    if (!response.ok) { console.log(`chat http ${response.status}`); return '' }
    const body = await response.json()
    return (body?.choices?.[0]?.message?.content ?? '').trim()
  } catch (error) {
    console.log(`chat failed: ${error.message}`)
    return ''
  }
}

async function transcribe(pcm8k) {
  if (ASR_URL !== '') {
    try {
      // pcm8k is Float32 samples; the service expects little-endian 16-bit PCM.
      const body = toPcm16(pcm8k)
      const response = await fetch(ASR_URL, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body })
      if (response.ok) return (await response.json()).text ?? ''
      console.log(`asr http ${response.status}; falling back to the local model`)
    } catch (error) {
      console.log(`asr unreachable (${error.message}); falling back to the local model`)
    }
  }
  const samples = resample(pcm8k, 8000, 16000)
  const stream = recognizer.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples })
  recognizer.decode(stream)
  return recognizer.getResult(stream).text.trim()
}

function render(text) {
  const audio = tts.generate({ text, sid: 0, speed: 1 })
  return toPcm16(resample(audio.samples, audio.sampleRate, RATE))
}

/** Short attention tone marking the end of the prompt and the start of listening. */
function tone(seconds) {
  const total = Math.round(RATE * seconds)
  const samples = new Float32Array(total)
  for (let i = 0; i < total; i++) samples[i] = 0.25 * Math.sin(2 * Math.PI * 1000 * i / RATE)
  return toPcm16(samples)
}
const ANNOUNCEMENT_PCM = Buffer.concat([render(ANNOUNCEMENT), tone(0.2)])
const CONFIRMATION_PCM = render(CONFIRMATION)
const PROMPT_PCM = render('Je vous écoute.')
console.log(`cached: announcement ${(ANNOUNCEMENT_PCM.length / 2 / RATE).toFixed(2)}s, confirmation ${(CONFIRMATION_PCM.length / 2 / RATE).toFixed(2)}s`)

const ASR_URL = process.env.ASR_URL ?? 'http://192.168.235.231:9030/transcribe'
const AGENT_URL = process.env.AGENT_URL ?? ''
const CHAT_URL = process.env.CHAT_URL ?? 'https://api.deepseek.com/chat/completions'
const CHAT_KEY = process.env.DEEPSEEK_API_KEY ?? ''
const CHAT_MODEL = process.env.CHAT_MODEL ?? 'deepseek-chat'
const CHAT_SYSTEM = process.env.CHAT_SYSTEM ?? "Tu es un assistant vocal au téléphone. Réponds en français, en une ou deux phrases courtes, sans markdown ni listes. Si tu ne peux pas vérifier une information en direct, dis-le simplement."
const AMI_HOST = process.env.AMI_HOST ?? '192.168.234.60'
const AMI_PORT = Number(process.env.AMI_PORT ?? 5038)
const AMI_USER = process.env.AMI_USER ?? 'dsh'
const AMI_SECRET = process.env.AMI_SECRET ?? 'DshVoice2026!Cluster'
const OUTCALL_CONTEXT = process.env.OUTCALL_CONTEXT ?? 'ctx-diverse-outcall-0f068c5b-7d01-4f2c-bd9f-bb3e9e9bba31'

/** Callers currently waiting for their far end to answer, newest last. */
const waiting = new Set()
/** Latest answer timestamp: the AudioSocket half connects after AMI reports the answer. */
let lastAnswerAt = 0
let amiSocket = null
let amiBuffer = ''

/**
 * Start one outbound call through AMI so the announcement begins exactly at answer.
 * @param to - destination number in E.164 form.
 */
function originate(to) {
  if (amiSocket === null) { console.log('ami not connected; cannot originate'); return }
  const action = [
    'Action: Originate',
    'Channel: Local/s@dsh-bridge',
    `Context: ${OUTCALL_CONTEXT}`,
    `Exten: ${to}`,
    'Priority: 1',
    'Async: true',
    `ActionID: dsh-${Date.now()}`,
    '', '',
  ].join('\r\n')
  amiSocket.write(action)
  console.log(`[ami] originate ${to}`)
}

function connectAmi() {
  amiSocket = connect(AMI_PORT, AMI_HOST, () => {
    amiSocket.write(['Action: Login', `Username: ${AMI_USER}`, `Secret: ${AMI_SECRET}`, 'Events: on', '', ''].join('\r\n'))
    console.log('[ami] connected')
  })
  amiSocket.setEncoding('utf8')
  amiSocket.on('data', chunk => {
    amiBuffer += chunk
    let index
    while ((index = amiBuffer.indexOf('\r\n\r\n')) >= 0) {
      const block = amiBuffer.slice(0, index)
      amiBuffer = amiBuffer.slice(index + 4)
      const fields = new Map(block.split('\r\n').map(line => {
        const at = line.indexOf(':')
        return at < 0 ? [line.trim(), ''] : [line.slice(0, at).trim(), line.slice(at + 1).trim()]
      }))
      if (fields.has('Response')) {
        console.log(`[ami] response ${fields.get('Response')} ${fields.get('Message') ?? ''} ${fields.get('ActionID') ?? ''}`.trim())
      }
      const event = fields.get('Event')
      if (event === 'Newstate' && (fields.get('Channel') ?? '').startsWith('IAX2/')) {
        console.log(`[ami] trunk ${fields.get('ChannelStateDesc')}`)
      }
      if (event === 'OriginateResponse' || event === 'Dial' || event === 'Bridge' || event === 'Hangup' || event === 'Newstate') {
        console.log(`[ami] event ${event} ${fields.get('Response') ?? ''} ${fields.get('Reason') ?? ''} ${fields.get('DialStatus') ?? ''} ${fields.get('ChannelStateDesc') ?? ''}`.trim())
      }
      // The PSTN leg going Up is the only reliable answer signal: the Local halves answer immediately.
      const answered = (event === 'Newstate' && (fields.get('Channel') ?? '').startsWith('IAX2/') && fields.get('ChannelStateDesc') === 'Up')
        || (event === 'Dial' && fields.get('DialStatus') === 'ANSWER')
      if (answered) {
        lastAnswerAt = Date.now()
        const target = [...waiting].pop()
        if (target !== undefined) { waiting.delete(target); target.onAnswered() }
      }
    }
  })
  amiSocket.on('error', error => console.log('[ami] error', error.message))
  amiSocket.on('close', () => { console.log('[ami] closed; retrying in 5s'); amiSocket = null; setTimeout(connectAmi, 5000) })
}
connectAmi()

process.on('uncaughtException', error => { console.log('uncaught', error instanceof Error ? error.message : String(error)) })

let calls = 0
createServer(socket => {
  const id = ++calls
  const inbound = []
  let pending = Buffer.alloc(0)
  let pumping = true
  let digits = ''
  let confirmed = false
  const window = []
  let listening = false
  let announced = false
  let muteUntil = 0
  let wasSpeaking = false
  const jobs = []
  let processing = false
  const runJobs = async () => {
    if (processing) return
    processing = true
    try {
      while (jobs.length > 0) {
        const captured = jobs.shift()
        let windowEnergy = 0
        for (const sample of captured) windowEnergy += sample * sample
        console.log(`[call ${id}] window rms=${Math.sqrt(windowEnergy / Math.max(1, captured.length)).toFixed(3)}`)
        const started = performance.now()
        let text = ''
        try { text = await transcribe(captured) }
        catch (error) { console.log(`[call ${id}] asr failed: ${error.message}`) }
        console.log(`[call ${id}] heard (${((performance.now() - started) / 1000).toFixed(2)}s): ${JSON.stringify(text)}`)
        const hallucination = /sous-titrage|amara\.org|merci d'avoir regardé|abonnez-vous/iu.test(text)
        if (text.length > 2 && !hallucination) {
          const reply = await answer(text)
          const spoken = reply === '' ? `J'ai entendu : ${text}.` : reply
          console.log(`[call ${id}] answer: ${spoken.slice(0, 120)}`)
          speak(render(spoken))
        } else console.log(`[call ${id}] discarded transcript`)
      }
    } finally { processing = false }
  }
  console.log(`[call ${id}] connected from ${socket.remoteAddress}`)

  const queue = []
  const speak = (pcm) => {
    const bytes = FRAME_SAMPLES * 2
    const frames = Math.ceil(pcm.length / bytes)
    for (let i = 0; i < frames; i++) queue.push(pcm.subarray(i * bytes, (i + 1) * bytes))
  }

  // Clock-driven pump: one 20 ms frame per 20 ms of wall time, catching up in small bursts so the
  // far end's buffer never underruns when a timer tick slips.
  let nextAt = performance.now()
  const pump = () => {
    if (!pumping || socket.destroyed) return
    const now = performance.now()
    let sent = 0
    while (now >= nextAt && sent < 25) {
      const pcm = queue.shift() ?? Buffer.alloc(FRAME_SAMPLES * 2)
      const header = Buffer.alloc(3); header[0] = FRAME_TYPE; header.writeUInt16BE(pcm.length, 1)
      socket.write(Buffer.concat([header, pcm]))
      nextAt += 20
      sent++
    }
    if (now - nextAt > 1000) nextAt = now
    // Speakerphone echoes our own voice back; ignore the tail for a moment after each phrase.
    if (queue.length > 0) wasSpeaking = true
    else if (wasSpeaking) { wasSpeaking = false; muteUntil = now + 700 }
    // Start listening only once our own audio has fully drained, so the handset echo is not transcribed.
    if (announced && !listening && queue.length === 0) { listening = true; quietSince = performance.now(); console.log(`[call ${id}] listening`) }
    setTimeout(pump, Math.max(0, nextAt - performance.now()))
  }
  pump()

  // Registered after the queue and pump exist: a late answer is adopted immediately.
  const call = { onAnswered: () => {
    console.log(`[call ${id}] answered; announcing`)
    announced = true
    speak(ANNOUNCEMENT_PCM)
  } }
  waiting.add(call)
  if (Date.now() - lastAnswerAt < 8000) { waiting.delete(call); call.onAnswered() }


  socket.on('data', data => {
    pending = Buffer.concat([pending, data])
    while (pending.length >= 3) {
      const type = pending[0], length = pending.readUInt16BE(1)
      if (pending.length < 3 + length) break
      const payload = pending.subarray(3, 3 + length)
      pending = pending.subarray(3 + length)
      if (type === 0x00) { pumping = false; socket.end(); return }
      if (type === 0x01) { console.log(`[call ${id}] uuid=${payload.toString('hex').slice(0, 8)}`); continue }
      if (type === 0x03) {
        const digit = payload.toString('ascii')
        digits = (digits + digit).slice(-8)
        console.log(`[call ${id}] dtmf ${JSON.stringify(digit)} buffer=${digits}`)
        if (!confirmed && digits.endsWith('99#')) {
          confirmed = true
          console.log(`[call ${id}] CONFIRMED: caller reports the audio is good`)
          queue.length = 0
          speak(CONFIRMATION_PCM)
          setTimeout(() => {
            // AudioSocket terminate frame: Asterisk returns from the app immediately instead of waiting for a read timeout.
            socket.write(Buffer.from([0x00, 0x00, 0x00]))
            pumping = false
            socket.end()
          }, CONFIRMATION_PCM.length / 2 / RATE * 1000 + 300)
        }
        continue
      }
      if (type === 0x10 || type === 0x12) {
        inbound.push(Buffer.from(payload))
        if (!listening || performance.now() < muteUntil) { speechMs = 0; silenceMs = 0; window.length = 0; continue }
        const frame = Buffer.from(payload)
        const samples = new Float32Array(frame.length / 2)
        let energy = 0
        for (let i = 0; i < samples.length; i++) {
          samples[i] = frame.readInt16LE(i * 2) / 32768
          energy += samples[i] * samples[i]
        }
        const rms = Math.sqrt(energy / Math.max(1, samples.length))
        if (rms > 0.015) {
          speechMs += 20; silenceMs = 0; window.push(samples)
        } else if (speechMs > 0) {
          silenceMs += 20; window.push(samples)
        }
        // Endpoint: 700 ms of quiet closes the utterance; a long monologue is cut at 15 s.
        const ended = (speechMs > 0 && silenceMs >= 700) || speechMs >= 15000
        if (ended) {
          const captured = concatSamples(window)
          const spoke = speechMs
          speechMs = 0; silenceMs = 0; window.length = 0
          if (spoke >= 250) { jobs.push(captured); void runJobs() }
          else console.log(`[call ${id}] ignored short utterance (${spoke}ms)`)
        }
      }
    }
  })
  socket.on('close', () => {
    pumping = false
    waiting.delete(call)
    const pcm = Buffer.concat(inbound)
    if (pcm.length > 0) {
      mkdirSync('/data/calls', { recursive: true })
      const rate = pcm.length > 0 ? 8000 : 8000
      writeFileSync(`/data/calls/caller-${id}-${rate}.wav`, wav(pcm, rate))
      console.log(`[call ${id}] caller ${(pcm.length / 2 / rate).toFixed(2)}s saved confirmed=${confirmed}`)
    }
  })
  socket.on('error', error => console.log(`[call ${id}] error ${error.message}`))
}).listen(PORT, '0.0.0.0', () => console.log(`audiosocket listening on ${PORT} (slin ${RATE} Hz)`))

createHttpServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (url.pathname === '/call') {
    const to = url.searchParams.get('to') ?? ''
    if (!/^[0-9+]{7,16}$/u.test(to)) { response.writeHead(400).end('invalid number'); return }
    originate(to)
    response.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ calling: to }))
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ calls, ami: amiSocket !== null }))
}).listen(HEALTH, '0.0.0.0', () => console.log(`health on ${HEALTH}`))
