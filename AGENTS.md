# AGENTS.md

Десктоп-питомец для [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Код плагина — `dsh-pet/` (ESM, TypeScript, Node ≥ 22.12). Пайплайн ассетов — `scripts/`. Промпты генерации — `prompts/`.

Полные нормы уже лежат в `.agents/skills/`. Не копируй их в ответ и не расходись с ними:

- `dsh-plugin-standards` — структура плагина, типы, границы слоёв, тесты
- `dsh-plugin-comment-spec` — модульные шапки и TSDoc
- `git-commit` — `type(scope): тема` и техническое тело
- `task-guardrails` — не выходить за рамки задачи

## Проверки

Из каталога `dsh-pet/`:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:cycles
npm run test
```

Менялся HTTP-контракт — ещё `npm run check:openapi`. Перед публикацией пакета — `npm run prepack`.

## Границы

- Правь `dsh-pet/src/`, не собранный `dsh-pet/lib/`.
- `step01/`–`step04/`, `video/*.mp4`, `.venv/` и `node_modules/` не коммитить.
- Секреты, токены и полные URL с учётными данными в код, логи и сообщения об ошибках не попадают.
- Коммит и push — только по явной просьбе. `origin` — форк владельца, `upstream` — `PC2005-cloud/dsh-pet`.
