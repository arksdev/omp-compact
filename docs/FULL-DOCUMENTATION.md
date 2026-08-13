# Полная документация omp-compact

Это расширенное руководство по установке, режимам, настройкам, evidence model, replay и сопровождению `omp-compact`. Краткий обзор доступен на [English](../README.md) и [Русском](../README.ru.md).

`omp-compact` — presentation-плагин для OMP 17.2.12 и выше. Он показывает активность инструментов как компактный хронологический лог, а после завершения logical run оставляет только полезные для истории строки.

Плагин не заменяет native tools и не меняет их выполнение. Schemas, approval, concurrency, progress, abort signals и tool results остаются под управлением stock OMP.

## Совместимость

Поддерживаемый диапазон: **OMP 17.2.12 и выше**. Автоматический release gate и manual smoke закреплены на stock OMP 17.2.12; будущие версии считаются совместимыми, пока не меняют private TUI shape, от которого зависит presentation adapter.

Перед установкой wrappers плагин проверяет capabilities живой сессии. Если новая версия OMP меняет shape несовместимым образом, установка wrappers откатывается целиком, OMP продолжает показывать штатный интерфейс, а плагин выводит одно предупреждение. Укажите exact OMP version и reproduction в GitHub issue, чтобы новый format можно было добавить в compatibility adapter.

## Установка

Production-код плагина находится в `.omp-plugin/`: `index.ts` импортирует соседние модули из этой директории.

### Marketplace

Для первого релиза каталог публикуется из этого же репозитория. Добавьте его и установите плагин:

```bash
omp plugin marketplace add arksdev/omp-compact
omp plugin install omp-compact@arksdev
```

Требуется OMP 17.2.12 или новее. Stock 17.2.12 остаётся pinned development/release host; newer hosts проходят runtime capability checks и fail-open при несовместимой private TUI shape.

### Из Git checkout на один запуск

```bash
git clone https://github.com/arksdev/omp-compact.git
cd omp-compact
bun install --frozen-lockfile
bun run omp
```

`bun run omp` изолирует локальную разработку: загружает только `./.omp-plugin/index.ts` через `--no-extensions`, не закрепляет display mode, не передаёт `--no-session` и снимает внешние `OMP_COMPACT_MODE`/`OMP_COMPACT_PLUGIN`. Это исключает двойную загрузку, если `omp-compact` уже установлен или связан в user scope. Для обычной работы после marketplace-установки или `omp plugin link .` запускайте простой `omp`, чтобы остальные extensions оставались включены.

Альтернативный direct launch:

```bash
omp --extension /absolute/path/to/omp-compact/.omp-plugin/index.ts
# или
omp -e /absolute/path/to/omp-compact/.omp-plugin/index.ts
```

### Для проекта или всех сессий пользователя

Рекомендуемый способ — Marketplace: он устанавливает package manifest и скрытую production-директорию `.omp-plugin/` вместе и не требует ручного копирования отдельных файлов.

Для ручного link-install используйте корень checkout:

```bash
omp plugin link /absolute/path/to/omp-compact --scope project
# или
omp plugin link /absolute/path/to/omp-compact --scope user
```

Manifest `package.json` указывает OMP на `./.omp-plugin/index.ts`. При `--profile <name>` user scope хранится в соответствующей profile agent directory; `PI_CODING_AGENT_DIR` переопределяет active agent directory. После установки или link перезапустите OMP.

Проверка загрузки: откройте `/compact-settings`. Если это имя уже занято, плагин последовательно использует `/omp-compact-settings`, затем `/omp-compact-settings-2` … `/omp-compact-settings-99`. Фактическое имя видно в списке slash-команд.

## Быстрый старт

Настройки по умолчанию:

- плагин включён;
- режим `live`;
- пути внутри session `cwd` сокращаются до project-relative;
- Git rows и aggregate commit summary включены;
- terminal statistics включена со всеми полями;
- auto-shake выключен;

Значения `host.*` в plugin config по умолчанию равны `true`, но загрузка плагина не переписывает stock OMP settings. В меню identity-matched live host values имеют приоритет; изменения применяются только при явном сохранении.

Во время работы mapped tool calls выглядят примерно так:

```text
Working… read src/index.ts
• read src/index.ts
• grep registerTool in src
• bash: bun test
• write: src/app.ts +17|0
• edit: src/theme.css +2|0
```

Pending row использует activity spinner текущей темы OMP. Settled rows начинаются с `•`; ошибки — с `✗`. Строки не получают background color и не дополняются пробелами до ширины терминала.

Для file mutations label остаётся нейтральным. Ненулевые additions имеют цвет `#A4D734`, removals — `#A1471A`, нули выводятся серым.

## Logical run и момент сворачивания

Один logical run может содержать несколько model/tool loops:

```text
agent_start
  -> assistant toolUse
  -> tool executions
  -> willContinue
  -> дополнительные model/tool loops
  -> terminal agent_end
```

`message_end`, `stopReason: "toolUse"` и `agent_end.willContinue === true` не считаются завершением задачи. Полный live-log остаётся на месте до terminal `agent_end` с видимым non-tool assistant answer.

После такой границы применяется выбранный режим. Если run завершился abort/error и финального ответа нет, плагин сохраняет полный diagnostic log. Незавершённая работа не исчезает без объяснения.

## Режимы

| Режим | Во время работы | После успешного terminal answer |
| --- | --- | --- |
| `compact` | Полный compact log mapped tools | Полный compact log остаётся в transcript |
| `live` | Полный compact log mapped tools | Остаются verified non-zero mutations, optional Git commit summary и optional stats |
| `clear` | Ordinary compact rows скрыты; штатная глобальная Working-строка и native interactive/unmapped surfaces не меняются | Tool rows скрыты; optional stats остаётся над ответом |

В `clear` abort/error без ответа всё равно сохраняет diagnostic compact rows. Это исключение нужно, чтобы не скрыть причину незавершённого run.

## Что остаётся в `live`

После успешного ответа строки остаются в таком порядке:

```text
• write: src/app.ts +17|0
• edit: src/theme.css +2|0
• git commit: 1983fsdf34, a4c12de890
[ 27 actions · 28.2k sent · 1.3k received · 95% cache (480.2k hit) · 1h 20m 32s ]
<assistant answer>
```

Сохраняются:

1. Успешные `write`/`edit` с проверенным `added > 0 || removed > 0`.
2. Одна строка подтверждённых commit hashes, если включён `Retain Git rows`.
3. Одна configurable stats row, если включена статистика.

Удаляются routine reads, searches, globs, ordinary shell calls, no-op mutations и прочие mapped tool rows.

### Mutation audit

Статистика mutation строится не из заявленного input, а из ограниченного и проверяемого evidence:

- для local `write` сравниваются фактические pre/post filesystem states;
- native `details.resolvedPath` должен соответствовать ожидаемому target;
- `edit` использует native `diff`/`perFileResults` и сохраняет успешные файлы даже при частично неуспешной aggregate operation;
- unified diff считается только внутри `@@` hunks;
- no-op `0|0` может быть виден во время работы, но не сохраняется после ответа.

Local snapshot audit не выводит `exact: true` только из предположения для URI, archive, SQLite, oversized или несовпавших targets. Для `edit` каждый успешный native `perFileResults` может дать exact per-file evidence, включая multi-file operation. Если изменение нельзя честно подтвердить, плагин оставляет нейтральный/inexact status либо не удерживает строку.

### Git summary

Git распознаётся консервативно из уже выполненного Bash command/result. Плагин не запускает скрытые `git log`, `rev-parse` или другие probes.

В режиме `live`:

- во время работы показываются распознанные Git rows, если `retainGitLive=true`;
- после ответа individual rows удаляются;
- в summary входят только успешные `git commit` records с доказанным hash;
- status/add/push/switch/rebase, failed commits и commits без hash в summary не входят;
- hashes сохраняют chronological order, newest hash остаётся видимым при узкой ширине.

`retainGitLive=false` скрывает Git rows и terminal commit summary в `live`. В `compact` полный Git log остаётся независимо от этого toggle; в `clear` ordinary Git rows скрыты вместе с остальными compact rows.

## Настройки

Откройте интерактивное меню:

```text
/compact-settings
```

Управление:

- `↑`/`↓` или `k`/`j` — перемещение;
- `←`/`→` — смена режима;
- `Space`/`Enter` — toggle или начало редактирования числа;
- `s` — сохранить;
- `Esc`, `c` или interrupt keybinding — закрыть без сохранения.

Открытие и отмена меню ничего не записывают. `enabled`, `mode`, `retainGitLive`, `compactPaths` и auto-shake gate фиксируются на границе logical run и не меняются в continuations. Stats toggles читаются при terminal finalization/replay, поэтому сохранение меню во время активного run может повлиять на его итоговую stats row.

### Параметры и defaults

| Пункт меню / JSON | Default | Назначение |
| --- | ---: | --- |
| `Global compact` / `enabled` | `true` | Включает runtime плагина. Settings command остаётся доступной при `false`. |
| `Mode` / `mode` | `"live"` | `compact`, `live` или `clear`. |
| `Compact paths` / `compactPaths` | `true` | Сокращает отображаемые absolute paths внутри session `cwd`. |
| `Retain Git rows` / `retainGitLive` | `true` | Показывает Git rows и aggregate commit summary в `live`. |
| `Auto-shake` / `autoShake.enabled` | `false` | Запускает native `shake("elide")` после eligible run. |
| `Shake threshold` / `autoShake.thresholdTokens` | `120000` | Минимальный current context usage; `0` означает каждый eligible run. |
| `Run statistics` / `stats.enabled` | `true` | Включает terminal stats row. |
| `Actions` / `stats.actions` | `true` | Число distinct tool executions, включая failures и unmapped tools. |
| `Sent tokens` / `stats.sent` | `true` | Сумма `usage.input` уникальных assistant completions. |
| `Received tokens` / `stats.received` | `true` | Сумма `usage.output`. |
| `Cache stats` / `stats.cache` | `true` | `cacheRead / (sent + cacheRead)` и число cache-hit tokens. |
| `Time` / `stats.time` | `true` | Wall time от `agent_start` до terminal `agent_end`. |
| `Recap summary` / `host.recapEnabled` | fallback `true` | Показывает live `recap.enabled`, если host settings доступны; меняет его только при save. |
| `Thinking blocks` / `host.thinkingBlocksVisible` | fallback `true` | Показывает inverse live `hideThinkingBlock`; меняет при save и требует restart OMP. |

Stats агрегируется по уникальным finalized assistant messages, а не по tool calls: один model response с несколькими tools не задваивает usage. `cacheWrite` учитывается в persisted evidence, но не считается cache hit и не выводится отдельным сегментом. Если хотя бы один tool завершился ошибкой, separators stats row используют warning color; иначе `#A4D734`.

### Config file

Default path:

```text
~/.omp/agent/omp-compact/config.json
```

Как вычисляется путь:

1. `OMP_COMPACT_CONFIG` — точный путь.
2. `$PI_CODING_AGENT_DIR/omp-compact/config.json`.
3. `$HOME/${PI_CONFIG_DIR:-.omp}/agent/omp-compact/config.json`.
4. При `PI_PROFILE`: `$HOME/${PI_CONFIG_DIR:-.omp}/profiles/$PI_PROFILE/agent/omp-compact/config.json`.

Формат версии 1:

```json
{
  "version": 1,
  "enabled": true,
  "mode": "live",
  "retainGitLive": true,
  "compactPaths": true,
  "stats": {
    "enabled": true,
    "actions": true,
    "sent": true,
    "received": true,
    "cache": true,
    "time": true
  },
  "autoShake": {
    "enabled": false,
    "thresholdTokens": 120000
  },
  "host": {
    "recapEnabled": true,
    "thinkingBlocksVisible": true
  }
}
```

Ограничения parser/store:

- размер не больше 65,536 bytes;
- nesting depth не больше 16;
- `thresholdTokens` — integer от `0` до `10,000,000`;
- поддерживается только `version: 1`;
- invalid fields получают defaults и вызывают одно предупреждение;
- запись выполняется через temporary file и same-directory atomic rename.

Host fields в JSON служат persisted mirror. Для изменения stock OMP settings используйте интерактивное меню либо штатный config OMP: простое ручное изменение этих двух JSON fields само по себе не вызывает host flush.

### Environment overrides

| Variable | Значения | Эффект |
| --- | --- | --- |
| `OMP_COMPACT_PLUGIN` | `0` или `false` | Hard-disable runtime. Settings command остаётся доступной. Другие значения не форсируют включение. |
| `OMP_COMPACT_MODE` | `compact`, `live`, `clear` | Переопределяет persisted mode. |
| `OMP_COMPACT_MODE` | `off` | Legacy hard-disable runtime. |
| `OMP_COMPACT_SHAKE` | `1` или `0` | Переопределяет только `autoShake.enabled`; threshold остаётся из config. |
| `OMP_COMPACT_CONFIG` | path | Переопределяет путь config file. |

Runtime precedence:

1. `OMP_COMPACT_PLUGIN=0|false` и `OMP_COMPACT_MODE=off` выключают runtime.
2. `OMP_COMPACT_MODE=compact|live|clear` переопределяет persisted mode.
3. Остальные значения берутся из JSON.
4. При отсутствии валидного JSON используются defaults.

Menu save не записывает env overrides в JSON. Если env маскирует только что сохранённое значение, меню сохраняет requested value, и одна notification сообщает сразу оба факта: сохранение выполнено и какая variable удерживает effective value (например, `omp-compact settings saved; effective mode remains live because OMP_COMPACT_MODE=live`).

## Project-relative paths

При `compactPaths=true` absolute path строго внутри session `cwd` показывается относительно него:

```text
/Volumes/work/project/src/index.ts:10-20
-> src/index.ts:10-20
```

Это только display projection. Аргументы native tool, filesystem audit и persisted evidence не изменяются.

Без изменений остаются:

- paths вне `cwd` и похожие prefix paths с другой segment boundary;
- уже relative paths;
- URIs;
- archive/SQLite selectors и query suffixes;
- значения с `..`;
- paths на другом volume.

Line/raw/conflict selectors после `:` сохраняются byte-for-byte.

## Auto-shake

Auto-shake — отдельный opt-in maintenance module. По умолчанию он выключен; настроенный default threshold равен `120000` токенов. Значение `0` означает каждый eligible logical run.

Плагин вызывает public API:

```ts
AgentSession.shake("elide", { signal })
```

`shake("elide")` заменяет тяжёлые старые tool results и крупные fenced/XML blocks короткими placeholders с `artifact://` recovery link. Он не создаёт LLM summary и не является OMP compaction strategy. Если context уже превысил лимит, auto-shake не выбирает другую compaction strategy или model fallback; дальнейшее восстановление остаётся за stock OMP context maintenance.

Вызов происходит, только если одновременно выполнены условия:

1. runtime плагина был включён на границе этого logical run;
2. auto-shake включён настройкой или `OMP_COMPACT_SHAKE=1`;
3. получен видимый successful terminal assistant answer;
4. нет `willContinue`, `toolUse`, abort или terminal error без ответа;
5. mutation/Git/stats evidence уже сохранён;
6. current context usage известен и не меньше положительного threshold, либо threshold равен `0`;
7. event относится к identity-matched main agent session;
8. shake ещё не запускался для этого logical run.

Missing session/API, persistence failure и native shake error не ломают ответ: плагин пропускает операцию и предупреждает один раз. Неизвестный usage при положительном threshold и usage ниже threshold приводят к тихому skip.

Auto-shake выключен по умолчанию, потому что удаление tool context может ухудшить follow-up questions и prompt caching. Включайте его осознанно.

## Stock recap и thinking blocks

Меню управляет ровно двумя stock settings:

- `Recap summary` -> `recap.enabled`: разрешает OMP после idle period сгенерировать краткое LLM recap текущего состояния; применяется без restart;
- `Thinking blocks` -> inverse `hideThinkingBlock`: показывает или скрывает reasoning/thinking blocks; требует restart OMP.

Плагин получает и сохраняет их только через initialized `session.settings` identity-matched main session. Host flush выполняется до записи mirror в plugin JSON; при failure host values откатываются, JSON не меняется и success notification не показывается. Плагин не импортирует global settings proxy и не вызывает `Settings.init()`.

Если verified host settings instance недоступен, строки показывают `n/a`; остальные plugin settings остаются рабочими. Browser Relay (`browser.relay`) и Collab Relay (`collab.relayUrl`) — отдельные stock OMP settings, которыми `omp-compact` не управляет.

## Presentation routes

Compact output применяется только к явно зарегистрированным structured shapes.

| Route | Tools |
| --- | --- |
| `read-group` | `read` |
| `compact` | `bash`, `write`, `edit`, `grep`, `glob`, `hub`, `todo`, `eval`, `yield`, `hus`, `web_search`, `ast_grep`, `ast_edit`, `inspect_image`, `browser`, `computer`, `resolve`, `reject`, `task` |
| `native-live` | `ask` |

Aliases нормализуются до routing и audit: `apply_patch` -> `edit`; hyphen spellings вроде `ast-grep`, `ast-edit` и `inspect-image` -> underscore form.

Read groups компактизируются только при полном и однозначном mapping всех entries. Mixed, unknown, ambiguous и incompatible groups остаются native. Обычные compact tool view могут использовать explicit expansion как escape hatch к stock presentation; browser, computer, resolve и reject остаются compact даже при раскрытии.

Unknown tool не получает generic compact row. Он остаётся native во всех phases, включая `clear`, чтобы новый или third-party tool нельзя было случайно скрыть.

Registry использует только structured tool name, args/result и component state. Rendered/ANSI text не парсится для определения tool identity.

## Почему архитектура plugin-only

### Native tools не переопределяются

Повторная регистрация built-ins потребовала бы копировать schemas, approval и concurrency metadata либо делегировать execution через другой context. Такой wrapper легко расходится с host и может ослабить safety contract. `omp-compact` оставляет оригинальный `AgentTool` установленным и меняет только presentation/audit поверх stock events.

### Патчатся только live instances

Imported или global prototype patch затронул бы другие сессии и был бы труднообратим. `RuntimeAdapter` ставит own-property wrappers только на конкретные `TranscriptContainer`, `ToolExecutionComponent` и `ReadToolGroupComponent` текущей сессии. Все descriptors и timers снимаются при rollback, switch и shutdown.

### Terminal boundary важнее отдельного tool result

Успешный tool может быть промежуточным шагом. Если удалить его строку на `tool_execution_end`, пользователь потеряет контекст, пока модель продолжает работу. Поэтому `TurnLedger` живёт от `agent_start` до terminal `agent_end`, а фильтрация выполняется один раз после готового ответа.

### Audit отделён от renderer

Renderer отвечает за строки. `AuditLifecycle` отвечает за bounded pre/post evidence, `git-records.ts` — за conservative Git parsing, `TurnLedger` — за retention. Typed registry лишь выбирает presentation route и audit kind. Он не читает filesystem, не разбирает Git и не управляет lifecycle.

Такое разделение не даёт правилам отображения превратиться в скрытый execution engine и позволяет неизвестным shapes безопасно остаться native.

## Основные модули

| Файл | Ответственность |
| --- | --- |
| `index.ts` | Extension entrypoint, events, command и session wiring. |
| `tool-presentation-rules.ts` | Typed routes, aliases, audit selectors и known structured shapes. |
| `runtime-adapter.ts` | Public lifecycle façade, exact-instance wrappers and terminal replay seam. |
| `host-adapter.ts` | Pinned 17.2.12 capability probes and transactional descriptor patches. |
| `component-binding.ts` | Exact-ID/proven-order component mapping and native fail-open statuses. |
| `runtime-session-state.ts` | Ledgers, rebuild generations, terminal projections and bounded payload retirement. |
| `render-decision.ts` | Pure mode/route projection decisions. |
| `turn-ledger.ts` | Logical-run boundary, phases и retention. |
| `transcript-fold.ts` | Deferred live region и terminal commit в native scrollback. |
| `audit.ts`, `audit-diff.ts`, `audit-lifecycle.ts` | Bounded file-mutation evidence и async lifecycle. |
| `git-records.ts` | Conservative Git command/result classification. |
| `config.ts`, `mode-policy.ts`, `settings-ui.ts` | Persistent config, immutable run snapshot и TUI settings. |
| `host-settings.ts` | Transactional bridge к двум initialized stock settings. |
| `run-stats.ts` | Usage aggregation, persisted evidence и terminal stats row. |
| `post-turn-shake.ts` | Isolated, default-off native context elision. |
| `display-path.ts` | Display-only project-relative paths. |
| `hydration-bounds.ts` | Pre-allocation replay identity/payload/carrier budgets. |

## Troubleshooting

### `/compact-settings` отсутствует

- Убедитесь, что загружен `index.ts`, а рядом находятся остальные `.ts` files плагина.
- Проверьте alternative command names `/omp-compact-settings` и `/omp-compact-settings-N`.
- Для project discovery запускайте OMP из того же directory, где находится `.omp`.
- Проверьте, что runtime — OMP 17.2.12 или новее; для нового несовместимого shape приложите exact version и reproduction к GitHub issue.

### Меню сообщает, что нужен interactive terminal

`ctx.ui.custom()` недоступен в headless/RPC context. Plugin-only settings можно изменить в JSON и применить со следующего logical run. Stock recap/thinking settings изменяйте через interactive menu либо штатный config OMP.

### Сохранённая настройка не действует

Проверьте `OMP_COMPACT_PLUGIN`, `OMP_COMPACT_MODE` и `OMP_COMPACT_SHAKE`. Env overrides имеют приоритет над JSON. `Thinking blocks` требует restart OMP; остальные runtime changes применяются на следующей границе logical run.

### Host rows показывают `n/a`

Плагин не нашёл identity-matched initialized Main session settings. Он намеренно не использует global settings proxy. Plugin-only rows можно сохранять; host rows станут доступны в подходящей interactive main session.

### Вместо compact rows виден stock UI

Это expected fail-open при unknown tool, expanded view, mixed read group или несовместимой TUI shape. Если native UI используется для всех известных tools, проверьте версию OMP и предупреждение `omp-compact` при session start.

### Path остался absolute

Сокращаются только absolute filesystem paths строго внутри captured session `cwd`. External paths, URIs, selectors с неподходящим base и небезопасные `..` остаются без изменений.

### Mutation row исчезла после ответа

В `live` остаются только successful, verified и non-zero mutations. No-op, failed, oversized, mismatched или неподтверждаемая operation не получает долговременную exact row.

### Git summary отсутствует

Проверьте `retainGitLive`, режим и result команды. Summary создаётся только в `live` для successful commit records с подтверждённым hash.

### Auto-shake не запустился

Проверьте toggle/env, threshold, наличие provider context usage и terminal outcome. Auto-shake не запускается для subagents, continuations, abort/error без ответа и globally disabled runs.

## Проверка в репозитории

Установите exact development dependencies и запустите весь gate из корня:

```bash
bun install --frozen-lockfile
bun run check
```

Отдельные команды:

```bash
bun run typecheck
bun run lint
bun run format:check
bun run test
```

`bun run test` задаёт `OMP_STOCK_BIN=./node_modules/.bin/omp` и запускает корпус из `docs/tests/`, включая redacted replay fixtures и stock-host integration contracts.

Ручной TUI smoke с сохранением обычной session history:

```bash
bun run omp
```

Launcher снимает внешние mode/plugin overrides, не задаёт режим сам и не передаёт `--no-session`. Поэтому выбранные в `/compact-settings` persisted settings определяют presentation, а session logs остаются доступными для последующего разбора.

Проверяйте как минимум:

- `compact`, `live`, `clear`;
- successful `/tree` navigation and manual `/shake`, followed by another live tool run in the same session;
- settings save/reopen;
- successful answer и abort/error без ответа;
- no-op и non-zero `write`/`edit`;
- successful/hashless/failed Git operations;
- stats fields и error color;
- auto-shake с threshold `0` и положительным threshold;
- unknown/expanded tool native fallback.

Последний core manual smoke (2026-08-12) resumed a prior session, observed all three modes, navigated `/tree`, shook one real tool result (`~3747` tokens) and completed live tool runs after both rebuild paths without restart/reopen.
