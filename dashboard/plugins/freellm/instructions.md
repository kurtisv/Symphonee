# FreeLLM plugin

FreeLLMAPI runs on this PC (port 3001) and offers one OpenAI-compatible endpoint over several free model providers. Prompts leave the machine (they go to the providers), so this plugin only serves PUBLIC or FICTIONAL work.

- `GET /api/plugins/freellm/status` : installed, running, configured.
- `POST /api/plugins/freellm/start` / `stop` : start or stop the process Symphonee launched.
- `POST /api/plugins/freellm/chat` `{ "prompt": "...", "scope": "public" | "fictional-fixture", "model": "optional" }` : one answer. Any other scope, or text that looks like a secret, personal data or payroll, is refused with 403 before any network call.

NEVER send a real repository's code, payroll data, client data or credentials through this plugin. Use Claude or the local Qwen for those.
The Qwen teacher in the autopilot already uses FreeLLM when a key is configured (`.symphonee/freellm.json`).
