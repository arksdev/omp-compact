# omp-compact

`omp-compact` — presentation-плагин для stock OMP 17.2.12. Во время работы он показывает tool calls как компактный хронологический лог, а после успешного logical run оставляет только подтверждённые изменения, Git summary и статистику.

Плагин не заменяет native tools и не меняет schemas, approval, concurrency, progress, abort signals или tool results. При несовместимой TUI shape он полностью откатывает свои wrappers и оставляет штатный интерфейс OMP.

## Возможности

- три режима: `compact`, `live` и `clear`;
- authoritative terminal filtering только после terminal assistant answer;
- verified non-zero `write`/`edit` evidence вместо доверия к заявленному input;
- conservative Git summary без скрытых probes;
- optional one-line run statistics и default-off auto-shake;
- same-session reconstruction после `/tree` и `/shake`;
- native fail-open для unknown, expanded, interactive и несовместимых surfaces.

```text
Working… read src/index.ts
• read src/index.ts
• grep registerTool in src
• bash: bun test
• write: src/app.ts +17|0
• edit: src/theme.css +2|0
```

После успешного ответа в default-режиме `live` routine rows и no-op mutations исчезают:

```text
• write: src/app.ts +17|0
• edit: src/theme.css +2|0
• git commit: 1983fsdf34, a4c12de890
[ 27 actions · 28.2k sent · 1.3k received · 95% cache (480.2k hit) · 1h 20m 32s ]
<assistant answer>
```

Abort/error без финального ответа сохраняет полный diagnostic log.

## Совместимость

Поддерживаемая и проверенная версия — **OMP 17.2.12**. Для другой версии необходимы повторные integration/replay checks и ручной TUI smoke.

## Установка

### Marketplace

```bash
omp plugin marketplace add arksdev/omp-compact
omp plugin install omp-compact@arksdev
```

После установки запустите обычный `omp` и откройте `/compact-settings`.

### Из Git checkout

```bash
git clone https://github.com/arksdev/omp-compact.git
cd omp-compact
bun install --frozen-lockfile
bun run omp
```

`bun run omp` — изолированный source-checkout launcher: он загружает только `./index.ts` через `--no-extensions`, чтобы уже установленная копия плагина не загрузилась второй раз. Для постоянной marketplace/link-установки используйте обычный `omp`, чтобы остальные extensions оставались включены.

Direct launch на один запуск:

```bash
omp -e /absolute/path/to/omp-compact/index.ts
```

## Режимы

| Режим | Во время работы | После успешного terminal answer |
| --- | --- | --- |
| `compact` | Полный compact log mapped tools | Полный log сохраняется |
| `live` | Полный compact log mapped tools | Verified mutations, optional Git summary и stats |
| `clear` | Ordinary compact rows скрыты | Tool rows скрыты, optional stats остаётся |

Настройки по умолчанию: `live`, project-relative paths, Git summary и stats включены; auto-shake выключен.

## Документация

- [Полная документация](docs/FULL-DOCUMENTATION.md) — installation variants, lifecycle, audit, settings, replay и troubleshooting.
- [Конфигурация](docs/CONFIGURATION.md) — JSON и environment reference.
- [Архитектура](docs/ARCHITECTURE.md) — internal design, lifecycle и safety boundaries.
- [Разработка](docs/CONTRIBUTING.md) — setup, checks и contribution workflow.
- [Изменения](CHANGELOG.md) — release history.

## Проверка

```bash
bun install --frozen-lockfile
bun run check
```

`bun run check` выполняет strict typecheck, lint, format check и полный test suite на pinned stock OMP 17.2.12.

## License

[MIT](LICENSE)
