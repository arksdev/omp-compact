# Полная документация omp-compact

Это расширенное руководство по установке, режимам, настройкам, evidence model, replay и сопровождению `omp-compact`. Краткий обзор доступен на [English](../README.en.md) и [Русском](../README.md).

`omp-compact` — presentation-плагин для OMP 18.0.1 и выше. Он показывает активность инструментов как компактный хронологический лог, а после завершения logical run оставляет только полезные для истории строки.

Плагин не заменяет native tools и не меняет их выполнение. Schemas, approval, concurrency, progress, abort signals и tool results остаются под управлением stock OMP.

## Совместимость

Поддерживаемый диапазон: **OMP 18.0.1 и выше**. Автоматический release gate и manual smoke закреплены на stock OMP 18.2.8; будущие версии считаются совместимыми, пока не меняют private TUI shape, от которого зависит presentation adapter.

Перед установкой wrappers плагин проверяет capabilities живой сессии. Если новая версия OMP меняет shape несовместимым образом, установка wrappers откатывается целиком, OMP продолжает показывать штатный интерфейс, а плагин выводит одно предупреждение. Укажите exact OMP version и reproduction в GitHub issue, чтобы новый format можно было добавить в compatibility adapter.

## Установка

Production-код плагина находится в `.omp-plugin/`: `index.ts` импортирует соседние модули из этой директории.

### Marketplace

Для первого релиза каталог публикуется из этого же репозитория. Добавьте его и установите плагин:

```bash
omp plugin marketplace add arksdev/omp-compact
omp plugin install omp-compact@arksdev
```

Требуется OMP 18.0.1 или новее. Stock 18.2.8 остаётся pinned development/release host; newer hosts проходят runtime capability checks и fail-open при несовместимой private TUI shape.

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

Для file mutations label остаётся нейтральным (кроме `delete` — см. ниже). Ненулевые additions имеют цвет `#A4D734`, removals — `#A1471A`, нули выводятся серым.

Операции удаления отображаются отдельной строкой: красный заголовок `delete`, серый путь, и красная точная статистика удалённых строк (`-N`) — только когда точное количество известно из pre-image:

```text
• write: src/app.ts +17|0
• edit: src/theme.css +2|0
• delete: src/gone.ts -3
```

Когда точное количество удалённых строк недоступно (oldText обрезан/отсутствует), статистика не выводится вовсе — строка остаётся `• delete: <path>` без оценки. Legacy записи удалений, сохранённые до появления `toolName: "delete"`, продолжают отображаться как `edit`-строки.

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

После такой границы применяется выбранный режим. Если run завершился abort/error и финального ответа нет, `compact` и `live` сохраняют полный diagnostic log. Незавершённая работа не исчезает без объяснения. В `clear` этого исключения нет — см. ниже.

## Режимы

| Режим | Во время работы | После успешного terminal answer |
| --- | --- | --- |
| `compact` | Полный compact log mapped tools | Полный compact log остаётся в transcript |
| `live` | Полный compact log mapped tools | Остаются verified non-zero mutations, optional Git commit summary и optional stats |
| `clear` | Ordinary compact rows скрыты; штатная глобальная Working-строка и native interactive/unmapped surfaces не меняются | Tool rows и mutation rows скрыты; optional Git commit summary и optional stats остаются над ответом |

В `clear` прерванный или упавший run скрывается так же, как успешный: rows не остаются ни во время работы, ни после abort/error. Диагностику незавершённого run смотрят в `compact` или `live` — в `clear` тишина экрана и есть смысл режима. Единственное исключение — итоговая строка с хешами созданных коммитов при включённом `retainGitLive`: коммиты остаются в истории и после прерванного run, и второго шанса показать их у режима нет. Восстановленная история подчиняется тому же правилу: rows и уведомления о завершении фоновой активности в `clear` скрыты, а в `compact` остаются.

## Что остаётся в `live`

После успешного ответа строки остаются в таком порядке:

```text
• write: src/app.ts +17|0
• edit: src/theme.css +2|0
• git commit: 1983fsdf34, a4c12de890
[ 27 actions · 508.4k prompt (28.2k fresh · 480.2k cached) · 1.3k received · 1h 20m 32s ] — 16:33
<assistant answer>
```

Сохраняются:

1. Успешные `write`/`edit` с проверенным `added > 0 || removed > 0`.
2. Одна строка подтверждённых commit hashes, если включён `Retain Git rows`.
3. Одна configurable stats row, если включена статистика. Справа от неё — локальное время завершения ответа (`hh:mm`), если включён `Add local time`; при восстановлении истории показывается то же время, что и в момент ответа.

Удаляются routine reads, searches, globs, ordinary shell calls, no-op mutations и прочие mapped tool rows.

### Mutation audit

Статистика mutation строится не из заявленного input, а из ограниченного и проверяемого evidence:

- для local `write` сравниваются фактические pre/post filesystem states;
- native `details.resolvedPath` должен соответствовать ожидаемому target;
- `edit` использует native `diff`/`perFileResults` и сохраняет успешные файлы даже при частично неуспешной aggregate operation;
- unified diff считается только внутри `@@` hunks;
- no-op `0|0` может быть виден во время работы, но не сохраняется после ответа;
- вызов внешнего устройства по адресу `xd://<устройство>` write-audit не проходит вовсе: это dispatch стороннего инструмента, а не запись файла.

Local snapshot audit не выводит `exact: true` только из предположения для URI, archive, SQLite, oversized или несовпавших targets. Для `edit` каждый успешный native `perFileResults` может дать exact per-file evidence, включая multi-file operation. Если изменение нельзя честно подтвердить, плагин оставляет нейтральный/inexact status либо не удерживает строку.

Если terminal `agent_end` приходит раньше, чем `tool_execution_end` успел забрать pending write/git audit-запись, lifecycle сразу abandon'ит эти pending records (terminal purge). Drain всё равно settles, чтобы adapter мог финализировать run, но `evidenceReady` остаётся `false`: для этого turn нет persisted `+N/−M` / Git evidence, и post-turn auto-shake не запускается. Completions, которые уже in flight к моменту `agent_end`, ждутся до внутреннего порога ~5s; сам порог не вынесен в настройки. Это fail-closed by design — лучше не показать stats, чем выдумать их при lag или reordering host events.

### Git summary

Git распознаётся консервативно из уже выполненного Bash command/result. Плагин не запускает скрытые `git log`, `rev-parse` или другие probes.

В режиме `live`:

- во время работы показываются распознанные Git rows, если `retainGitLive=true`;
- после ответа individual rows удаляются;
- в summary входят только успешные `git commit` records с доказанным hash;
- status/add/push/switch/rebase, failed commits и commits без hash в summary не входят;
- hashes сохраняют chronological order, newest hash остаётся видимым при узкой ширине.

`retainGitLive=false` скрывает Git rows и terminal commit summary в `live`. В `compact` полный Git log остаётся независимо от этого toggle. В `clear` ordinary Git rows скрыты вместе с остальными compact rows, но terminal commit summary остаётся: созданные commits — единственная evidence, которую тихий режим не прячет, иначе log утверждал бы, что ничего не произошло, там где история изменилась. При `retainGitLive=false` summary не остаётся и в `clear`.

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
- на строке `Cycle shortcut` — `Enter` начинает ввод сочетания текстом, `Enter` подтверждает, `Esc` отменяет.

Открытие и отмена меню ничего не записывают. `enabled`, `mode`, `retainGitLive`, `compactPaths`, `compactVibeRows` и auto-shake gate фиксируются на границе logical run и не меняются в continuations. Stats toggles читаются при terminal finalization/replay, поэтому сохранение меню во время активного run может повлиять на его итоговую stats row.

### Горячая клавиша переключения вида

`alt+c` работает по умолчанию, включать её не нужно. Каждое нажатие делает один шаг по кругу:

```text
compact → live → clear → off → compact
```

Режим меняется только между тремя включёнными состояниями; признак включённости плагина переключается только на входе в `off` и на выходе из него. При выключении последний режим остаётся в config file, поэтому случайное нажатие ничего не теряет; при включении круг всегда начинается с `compact`, поэтому порядок не зависит от того, с какого места вы в него вошли.

После нажатия печатается одна строка о том, что применится: `Compact: live — takes effect next run` для режимов и `Compact: off — from the next run` для выключения. Название режима подсвечивается зелёным.

Два неочевидных момента:

- **Нажатие применяется со следующего logical run.** Снимок настроек берётся один раз на прогон, поэтому нажатие посреди прогона не меняет уже отрисовываемый ответ.
- **Смена сочетания требует restart OMP.** Интерфейс расширений умеет регистрировать сочетание, но не умеет снимать регистрацию, поэтому новое сочетание начинает работать только после перезапуска. Меню сообщает об этом при сохранении.

Если значение закреплено `OMP_COMPACT_PLUGIN` или `OMP_COMPACT_MODE`, нажатие честно сообщает закреплённое значение, а не делает вид, что переключение состоялось.

### Параметры и defaults

| Пункт меню / JSON | Default | Назначение |
| --- | ---: | --- |
| `Global compact` / `enabled` | `true` | Включает runtime плагина. Settings command остаётся доступной при `false`. |
| `Mode` / `mode` | `"live"` | `compact`, `live` или `clear`. |
| `Compact paths` / `compactPaths` | `true` | Сокращает отображаемые absolute paths внутри session `cwd`. |
| `Retain Git rows` / `retainGitLive` | `true` | Показывает Git rows и aggregate commit summary в `live`. |
| `vibe-compact` / `compactVibeRows` | `true` | Включает compact rows для пяти инструментов vibe. При `false` они рисуются stock framed card в любом режиме. |
| `Advisor nit/concern` / `compactAdvisorNotes` | `false` | Сворачивает non-blocking заметки советника (`nit`/`concern`) в одну строку на заметку, включая длинные — переносы воспроизводятся как в карточке. `blocker`, неизвестные severity, нечитаемый payload и неподтверждённые карточки остаются native; расширение всегда показывает stock-карточку целиком. |
| `Cycle shortcut` / `displayCycleKey` | `"alt+c"` | Сочетание, переключающее вид вывода по кругу. Занятое OMP сочетание отклоняется при вводе. Смена требует restart OMP. |
| `Auto-shake` / `autoShake.enabled` | `false` | Запускает native `shake("elide")` после eligible run. |
| `Shake threshold` / `autoShake.thresholdTokens` | `120000` | Минимальный current context usage; `0` означает каждый eligible run. |
| `Run statistics` / `stats.enabled` | `true` | Включает terminal stats row. |
| `Actions` / `stats.actions` | `true` | Число distinct tool executions, включая failures и unmapped tools. |
| `Fresh input` / `stats.sent` | `true` | Сумма `usage.input` уникальных assistant completions — свежие, некэшированные токены входа. |
| `Received tokens` / `stats.received` | `true` | Сумма `usage.output`. |
| `Cached tokens` / `stats.cache` | `true` | `cacheRead / (sent + cacheRead)` и число кэш-токенов; вместе с свежими и записями кэша даёт полный prompt. |
| `Time` / `stats.time` | `true` | Wall time от `agent_start` до terminal `agent_end`. |
| `Add local time` / `stats.clock` | `true` | Локальное время завершения ответа (`hh:mm`) справа от строки, за скобками. Берётся из момента terminal `agent_end`, поэтому restored history показывает время самого ответа, а не время перерисовки. |
| `Recap summary` / `host.recapEnabled` | fallback `true` | Показывает live `recap.enabled`, если host settings доступны; меняет его только при save. |
| `Thinking blocks` / `host.thinkingBlocksVisible` | fallback `true` | Показывает inverse live `hideThinkingBlock`; меняет при save и требует restart OMP. |

Stats агрегируется по уникальным finalized assistant messages, а не по tool calls: один model response с несколькими tools не задваивает usage. `cacheWrite` учитывается в persisted evidence, не считается cache hit и не выводится отдельным сегментом — но при ненулевом значении входит в полный prompt как третья часть разбивки: `7.7M prompt (1.3M fresh · 5.4M cached · 950k written)`. Если хотя бы один tool завершился ошибкой, separators stats row используют warning color; иначе `#A4D734`.

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
  "compactVibeRows": true,
  "compactAdvisorNotes": false,
  "displayCycleKey": "alt+c",
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
- запись выполняется через temporary file и same-directory atomic rename;
- очередь writers — только in-process: disjoint edits в одном процессе сливаются leaf-патчем, а writers в разных OS processes на одном JSON path остаются last-writer-wins (без lock file; atomic rename не даёт torn reads).

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
| `compact` | `bash`, `write`, `edit`, `grep`, `glob`, `find`, `hub`, `todo`, `eval`, `yield`, `hus`, `web_search`, `ast_grep`, `ast_edit`, `inspect_image`, `browser`, `computer`, `resolve`, `reject`, `task`, `vibe_spawn`, `vibe_send`, `vibe_wait`, `vibe_kill`, `vibe_list` |
| `native-live` | `ask` |

Aliases нормализуются до routing и audit: `apply_patch` -> `edit`, `jfind` -> `find` (модуль семантического поиска в хосте называется `jfind`); hyphen spellings вроде `ast-grep`, `ast-edit` и `inspect-image` -> underscore form.

Read groups компактизируются только при полном и однозначном mapping всех entries. Mixed, unknown, ambiguous и incompatible groups остаются native. Обычные compact tool view могут использовать explicit expansion как escape hatch к stock presentation; browser, computer, resolve и reject остаются compact даже при раскрытии.

Unknown tool не получает generic compact row. Он остаётся native во всех phases, включая `clear`, чтобы новый или third-party tool нельзя было случайно скрыть.

Registry использует только structured tool name, args/result и component state. Rendered/ANSI text не парсится для определения tool identity.

### Вызовы внешних устройств

Часть инструментов вызывается через транспорт записи: адрес `xd://<устройство>` вместо пути к файлу, а аргументы вызова лежат в теле записи. Такая строка показывает само устройство заголовком и его операцию описанием (`github` -> `pr_create`, `security_scan` -> `preflight`), а не транспортный путь: `write: xd://github` читалось бы как запись в несуществующий файл. Операция берётся из structured args вызова — из написания `op` или `action`; устройство без операции печатает только имя, без заглушек. Если тело вызова ещё не дописано, не разбирается как JSON-объект или превышает бюджет разбора, строка тоже остаётся с одним именем устройства, а операция появляется из подтверждённых аргументов результата, когда вызов завершится.

Текстовые устройства (`resolve`, `reject`, `propose`, `report_issue`) несут не JSON-аргументы, а короткую причину, поэтому получают оформление resolution: собственный заголовок и цвет, причина описанием, action и источник в settled metadata.

Вызов устройства не является изменением файла и в mutation audit не попадает: адрес — транспортный, а не путь к файлу, поэтому такой вызов не заводит write-запись и не может приписать локальную правку файла обращению к устройству. Обычная запись файла продолжает проходить полный pre/post audit без изменений.

### Параллельные рабочие сессии

Пять инструментов управления worker sessions (`vibe_spawn`, `vibe_send`, `vibe_wait`, `vibe_kill`, `vibe_list`) вместо stock framed «TV wall» получают собственную compact grammar: одна-две строки на сессию.

Строка сессии собирается из известных полей snapshot: glyph состояния, badge вида worker (`⟦f⟧` / `⟦g⟧`), имя сессии, число ходов и глубина очереди (`3t+2q`), длительность текущего хода, короткое имя модели и текст последней активности либо текущего инструмента. Running-сессия анимируется тем же braille-кадром, что и обычная строка «ещё думаем…»; `vibe_wait` обновляет свои строки на каждом промежуточном результате, пока ожидание блокирует.

`vibe_list` печатает заголовок `vibe sessions N` со числом скрытых сессий, если такие есть. `vibe_wait` печатает заголовок с числом сессий в работе и числом settled, а при истёкшем окне ожидания — пометку `timed out`; заголовок опускается, когда напечатана ровно одна карточка. Пустой набор строк — законный исход: `vibe_kill` не печатает ничего, а мёртвые сессии, снятые и упавшие ходы исчезают по короткому TTL после последней активности.

Explicit expansion работает как обычный escape hatch: раскрытый вызов возвращает stock framed card. Ошибка вызова печатается одной строкой `✘` с целью вызова и текстом ошибки.

Compact grammar управляется настройкой `vibe-compact` / `compactVibeRows` (по умолчанию включена). При `false` все пять инструментов рисуются stock framed card так, как если бы плагин их не знал: не пустой строкой и не generic compact row. Флаг фиксируется на границе logical run вместе с mode, поэтому сохранение меню посреди прогона не меняет картинку на полпути.


### Заметки советника (advisor notes)

Карточка советника (`customType: "advisor"`) в OMP рисуется не через зарегистрированный
message renderer, а напрямую: host сам добавляет в транскрипт результат
`createAdvisorMessageCard(details, getExpanded, theme)`. Компонент непрозрачный — это
объект-литерал с `render`/`invalidate` (в 18.2.5+ ещё `dispose` и `setIgnoreTight`), а
заметки остаются в замыкании. Поэтому плагин не патчит «карточку advisor» по заголовку
или по порядку детей: он сопоставляет полностью снятые native-строки карточки с
раскладкой, которую stock-рендерер построил бы для одного разобранного `details`, и
патчит карточку только при точном совпадении ровно с одним кандидатом.

Что важно знать:

- **Opt-in.** Настройка `Advisor nit/concern` / `compactAdvisorNotes` по умолчанию
  выключена: при апгрейде ничего не меняется само собой. Выключенная настройка не
  рендерит карточки на probe-ширине и не трогает ни один компонент.
- **Сворачиваются только non-blocking заметки** — `nit` и `concern` (и отсутствующий
  severity: host документирует его как plain nit). Длинные заметки — не исключение:
  перенос строк воспроизводится тем же host-хелпером (`wrapTextWithAnsi`) и теми же
  ширинами, что и в карточке, поэтому многострочная заметка остаётся доказанной.
  `blocker` любого вида, неизвестный severity, управляющие символы в тексте и коллизия
  «две разные заметки дают одни и те же строки» оставляют карточку целиком native.
- **Нечитаемый payload не сворачивается.** Если у показанного сообщения непустой
  `details.notes`, но запись не разбирается (не тот тип, пустой текст, запись сверх
  лимита в 64 заметки), сворачивание отключается целиком — до следующей гидрации ветки
  или пересборки транскрипта, когда каталог кандидатов строится заново: такая карточка
  может спрятать нечитаемую запись за пределами первых трёх и нарисовать те же строки,
  что и доказанная, поэтому приписывать ей чужое доказательство нельзя. Карточки без
  заметок (`{}`, `{ "notes": [] }`) рисуют заголовок `Advisor 0 notes`, который не
  совпадает ни с одним кандидатом, и на остальные карточки не влияют. Отдельно от этого
  стоит бюджет: суммарный payload заметок сверх 1 МиБ даёт такой же отказ, который
  снимается следующей гидрацией.
- **Раскрытие всегда выигрывает.** При включённом tool-output expansion обёртка отдаёт
  native-карточку целиком: компактная строка существует только в свёрнутом состоянии, и
  полный текст заметки всегда доступен одним переключением.
- **Ничего не мутируется.** Сообщение, `details`, сессия и контекст модели не
  переписываются: компактный вид — это только набор строк, возвращаемых `render`.
- **Не подтверждённые карточки остаются native.** Живая карточка, добавленная до
  прихода метаданных, и восстановленная карточка без branch evidence рисуются как
  stock; обновление настройки или новое сообщение переоценивает их.
- **Совместимость.** Фабрика карточки лежит в
  `pi-coding-agent/src/modes/components/advisor-message.ts` до 18.2.0 и в
  `pi-tui/src/chat/advisor-message.ts` начиная с 18.2.5; тестовый harness резолвит оба
  пути. Реконструкция читает chrome из живого theme (`theme.status.info`,
  `theme.sep.dot`, `theme.symbol("advisor.rail")`, `theme.format.bracket*`), поэтому на
  хосте без этих полей карточка снова просто native.

Строка компактного вида:

```text
• advisor [nit] Keep the concise label
• advisor [concern] [Luna] Check the transaction boundary
  … +1 more note
```

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
| `tool-rule-describers.ts` | Pure describer-поведение правил: describe/resultMeta, текстовые устройства и hub launch-зеркало. |
| `runtime-adapter.ts` | Public lifecycle façade, exact-instance wrappers and terminal replay seam. |
| `presentation-patches.ts` | Exact-instance descriptor-patch registries и их двух-scope teardown (detach для per-component, dispose-only для transcript/discovery). |
| `host-adapter.ts` | Pinned 18.2.8 capability probes и transactional descriptor patches; re-exports the host-surface sheet so existing importers keep their path. |
| `host-surface.ts` | Pinned stock host surface sheet: method-name manifests, component fingerprints и argument-position decoders. |
| `component-binding.ts` | Exact-ID/proven-order component mapping and native fail-open statuses. |
| `runtime-session-state.ts` | Ledgers, terminal projections and bounded payload retirement. |
| `rebuild-lifecycle.ts` | Branch hydration walks, rebuild generations and replayed stats carriers. |
| `render-decision.ts` | Pure mode/route projection decisions. |
| `render.ts` | Row construction: mutations, git, stats и vibe rows. |
| `render-scrape.ts` | Scraping компактных view из live stock компонентов: публичные accessor-пробы, fail open к native. |
| `turn-ledger.ts` | Logical-run boundary, phases и retention. |
| `transcript-fold.ts` | Deferred live region и terminal commit в native scrollback. |
| `audit.ts`, `audit-diff.ts`, `audit-lifecycle.ts` | Bounded file-mutation evidence и async lifecycle. |
| `git-records.ts` | Conservative Git command/result classification. |
| `vibe-cards.ts` | Re-export entry point: barrel для модулей vibe cards. |
| `vibe-cards-decode.ts` | Defensive decoding untrusted vibe payloads в валидированные структуры. |
| `vibe-cards-render.ts` | Compact rows для параллельных worker sessions. |
| `vibe-cards-slots.ts` | Slot formatters: санитизация и форматирование отдельных слотов строки. |
| `config.ts`, `mode-policy.ts` | Persistent config и immutable run snapshot. |
| `settings-ui.ts` | Re-export entry point: barrel для модулей settings UI. |
| `settings-keys.ts` | Raw key codes и нормализация стрелок. |
| `host-api.ts` | Структурные host API типы и регистрация command/shortcut. |
| `ansi-width.ts` | ANSI-SGR-safe strip и truncate. |
| `save-flow.ts` | Save flow: host bridge apply → JSON persist → optional reload. |
| `cycle-handler.ts` | Keypress handler display-cycle через saveSettingsFlow. |
| `settings-dialog.ts` | TUI settings dialog. |
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
- Проверьте, что runtime — OMP 18.0.1 или новее; для нового несовместимого shape приложите exact version и reproduction к GitHub issue.

### Меню сообщает, что нужен interactive terminal

`ctx.ui.custom()` недоступен в headless/RPC context. Plugin-only settings можно изменить через JSON file; in-process store updates (включая `/compact-settings` save) применяются на следующей границе logical run. Ручная правка JSON вне процесса подхватывается после reload config (новый process / session restart), а не автоматически mid-session. Stock recap/thinking settings изменяйте через interactive menu либо штатный config OMP.

### Сохранённая настройка не действует

Проверьте `OMP_COMPACT_PLUGIN`, `OMP_COMPACT_MODE` и `OMP_COMPACT_SHAKE`. Env overrides имеют приоритет над JSON. `Thinking blocks` требует restart OMP; остальные runtime changes через store применяются на следующей границе logical run.

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
