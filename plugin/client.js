/**
 * dsh-plugin-phone — BROWSER half.
 *
 * Relays a telephone conversation through the page's own authenticated session:
 * pending phone text is typed into the composer and sent, and the finished
 * assistant reply is posted back to the host so the bridge can speak it.
 *
 * The page owns the credential; the host half only stores text.
 *
 * @module dsh-plugin-phone/client
 */

window.__ModuleLoader__.load({
	id: 'dsh-plugin-phone',
	factory: (require) => {
		const module = { exports: {} }
		const exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const INBOX = '/phone/inbox'
		const REPLY = '/phone/reply'
		const POLL_MS = 1000

		/** The harness composer, a Lexical contentEditable marked for automation. */
		function findComposer() {
			return document.querySelector('[data-composer-input="true"]')
		}

		/** Read the composer's current text. */
		function composerText(element) {
			return element === null ? '' : (element.innerText ?? '')
		}

		/**
		 * Type text into the composer the way a person would.
		 * @param text - utterance to insert.
		 * @returns whether the text landed in the composer.
		 */
		function insertText(text) {
			const element = findComposer()
			if (element === null) return false
			element.focus()
			const selection = window.getSelection()
			const range = document.createRange()
			range.selectNodeContents(element)
			range.collapse(false)
			selection?.removeAllRanges()
			selection?.addRange(range)
			const inserted = document.execCommand('insertText', false, text)
			if (inserted) return true
			element.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
			return composerText(element).includes(text)
		}

		/** Send the composer contents; Ctrl+Enter sends or steers depending on agent state. */
		function submitComposer() {
			const element = findComposer()
			if (element === null) return false
			const before = composerText(element)
			element.dispatchEvent(new KeyboardEvent('keydown', {
				key: 'Enter', code: 'Enter', keyCode: 13, which: 13, ctrlKey: true, bubbles: true, cancelable: true,
			}))
			window.setTimeout(() => {
				const now = findComposer()
				if (now === null || composerText(now) !== before || composerText(now).trim() === '') return
				const button = [...document.querySelectorAll('button')].find(candidate => /send|envoyer/iu.test(candidate.getAttribute('aria-label') ?? candidate.textContent ?? ''))
				if (button !== undefined && !button.disabled) button.click()
			}, 400)
			return true
		}

		/**
		 * Report one finished reply to the host.
		 * @param text - the assistant text of the turn.
		 */
		function reportReply(text) {
			if (typeof text !== 'string' || text.trim() === '') return
			void fetch(REPLY, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text }),
			}).catch(() => undefined)
		}

		/** Take one pending utterance from the host and speak it into the conversation. */
		async function pollInbox() {
			try {
				const response = await fetch(INBOX, { method: 'GET' })
				if (!response.ok) return
				const body = await response.json()
				if (typeof body?.text !== 'string' || body.text.trim() === '') return
				if (!insertText(body.text)) return
				submitComposer()
			} catch {
				// Host busy or reloading; the next tick retries.
			}
		}

		/** Accumulator that keeps the settled text of the current turn. */
		const definition = {
			kind: 'phone',
			match: event => {
				if (event?.data === undefined) return null
				if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
				if (event.type === 'assistant/message' || event.type === 'turn/end') return { id: String(event.data.turn), role: 'update' }
				return null
			},
			start: (_context, match) => ({ turn: match.event.data.turn, text: '' }),
			update: (context, match) => {
				const state = context.state ?? { turn: match.event.data.turn, text: '' }
				const event = match.event
				if (event.type === 'assistant/message') {
					const blocks = event.data.message?.content ?? []
					const text = blocks
						.filter(block => block?.type === 'text' && typeof block.text === 'string')
						.map(block => block.text)
						.join('')
					return text.trim() === '' ? state : { ...state, text }
				}
				if (event.type === 'turn/end') {
					reportReply(state.text)
					return state
				}
				return state
			},
			buildLocationData: () => null,
		}

		/**
		 * Client plugin entry.
		 * @param ctx - client context owning the conversation event registry.
		 */
		function apply(ctx) {
			ctx.uiConversation.events.register(definition)
			window.setInterval(() => { void pollInbox() }, POLL_MS)
		}

		exports.apply = apply
		exports.inject = ['uiConversation']
		return module.exports
	},
})
