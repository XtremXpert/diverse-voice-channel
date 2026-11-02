# diverse-voice-channel

Téléphone ↔ agent vocal : un appel téléphonique aboutit dans **DeepSeek Harness**, qui répond par la voix.

## Architecture

```
téléphone
   │  PSTN (ulaw 8 kHz)
   ▼
Wazo / Asterisk 22 ── AudioSocket (8 kHz slin) ──►  AVA Core (ai_engine, Docker)
   ▲                                                  │
   │                                                  ├─ STT  : local_ai_server (Whisper)
   │                                                  ├─ LLM  : agent-service (DeepSeek Harness, SDK Python)
   └────────────── TTS : local_ai_server (Piper) ◄────┘
```

La parole reste locale sur le Mac ; seul le texte traverse le réseau.
Le harnais est joint par sa **façade OpenAI** (`/v1/chat/completions`) adossée au SDK Python officiel :
le téléphone est donc un canal de communication standard, pas un agent séparé.

## Composants

| Dossier | Rôle |
|---|---|
| `ava/phone_harness.yaml` | pipeline AVA : `local_stt` + `native_llm` + `local_tts` |
| `services/asr-service.py` | Whisper large-v3-turbo (MLX) exposé en HTTP, 8 kHz slin → texte |
| `services/agent-service.py` | pont vers le harnais : `harness.run(texte)` et façade OpenAI |
| `asterisk/dsh-voice.conf` | contexte `dsh-bridge` (Answer, MixMonitor, AudioSocket) et extension 1099 |
| `plugin/` | canal harnais côté application (route `/phone/ask`, session persistante) |
| `legacy-k8s/bridge.mjs` | premier pont AudioSocket autonome, conservé comme référence |

## Mise en route (résumé)

1. **AVA** : `git clone https://github.com/hkjarral/AVA-AI-Voice-Agent-for-Asterisk`, `docker compose up -d ai_engine admin_ui local_ai_server`.
2. **Pipeline** : ajouter `ava/phone_harness.yaml` sous `pipelines:` dans `config/ai-agent.yaml`, puis
   `active_pipeline: phone_harness` et `default_provider: phone_harness`.
3. **Réseau Docker** : `ai_engine` et `local_ai_server` en bridge avec `8090:8090`, `15000:15000`, `8765:8765`.
   `network_mode: host` ne publie **rien** sur macOS.
4. **Services du Mac** : `python services/asr-service.py` (9030) et `python services/agent-service.py` (9031),
   ce dernier avec `DEEPSEEK_API_KEY` et le paquet `deepseek-harness-sdk`.
5. **Asterisk** : copier `asterisk/dsh-voice.conf` dans `/etc/asterisk/extensions_extra.d/`, `dialplan reload`.
6. **ARI** : `bindaddr=0.0.0.0` et `bindport=5039` dans `/etc/asterisk/http.d/01-wazo.conf`, puis redémarrer Asterisk.

## État

- Appel sortant, annonce au décroché, DTMF `99#` de confirmation, capture audio : validés.
- STT (Whisper MLX, ~0,35 s) et LLM (harnais, ~2,5 s) : validés séparément.
- Reste : le jeton `LOCAL_WS_AUTH_TOKEN` entre `ai_engine` et `local_ai_server`, qui refuse de binder `0.0.0.0` sans lui.

## Prérequis

- Asterisk ≥ 18 avec `res_audiosocket` et ARI.
- Docker Compose.
- Une clé `DEEPSEEK_API_KEY` pour le harnais.
