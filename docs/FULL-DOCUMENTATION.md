# Полная документация omp-compact

Это расширенное руководство по установке, режимам, настройкам, evidence model, replay и сопровождению `omp-compact`. Краткий обзор доступен на [English](../README.en.md) и [Русском](../README.md).

`omp-compact` — presentation-плагин для OMP 18.17 и выше. Он показывает активность инструментов как компактный хронологический лог, а после завершения logical run оставляет только полезные для истории строки.

Плагин не заменяет native tools и не меняет их выполнение. Schemas, approval, concurrency, progress, abort signals и tool results остаются под управлением stock OMP.

## Совместимость

Поддерживаемый диапазон: **OMP 18.17 и выше**. Плагин рисует через публичный API OMP `pi.registerTranscriptPresenter` и не патчит классы OMP. OMP спрашивает presenter, только пока включена настройка `extensionRenderers.transcriptPresenters` (**Tools → Extensions → Extension Transcript Presenters**, по умолчанию выключена). Плагин эту настройку не меняет; если инструмент запустился, а OMP так и не спросил presenter, плагин один раз показывает предупреждение.

## Установка

Production-код плагина находится в `.omp-plugin/`: `index.ts` импортирует соседние модули из этой директории.

### Marketplace

Для первого релиза каталог публикуется из этого же репозитория. Добавьте его и установите плагин:

```bash
omp plugin marketplace add arksdev/omp-compact
omp plugin install omp-compact@arksdev
```

Требуется OMP 18.17 или новее. После установки и перезапуска включите настройку OMP, через которую рисует плагин; по умолчанию она выключена:

```text
/settings → Tools → Extensions → Extension Transcript Presenters
```

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

Во время работы mapped tool calls выглядят примерно так:

```text
• read src/index.ts
• grep registerTool in src
• bash: bun test
• write: src/app.ts +17|0
• edit: src/theme.css +2|0
```

Значок в начале строки рисует OMP. Строки не получают background color и не дополняются пробелами до ширины терминала.

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
| `clear` | Ordinary compact rows скрыты; native interactive surfaces не меняются | Tool rows и mutation rows скрыты; optional Git commit summary остаётся, optional stats — под ответом |

В `clear` прерванный или упавший run скрывается так же, как успешный: rows не остаются ни во время работы, ни после abort/error. Диагностику незавершённого run смотрят в `compact` или `live` — в `clear` тишина экрана и есть смысл режима. Единственное исключение — итоговая строка с хешами созданных коммитов при включённом `retainGitLive`: коммиты остаются в истории и после прерванного run, и второго шанса показать их у режима нет. Восстановленная история подчиняется тому же правилу: rows и уведомления о завершении фоновой активности в `clear` скрыты, а в `compact` остаются.

## Что остаётся в `live`

После успешного ответа строки остаются в таком порядке:

```text
• write: src/app.ts +17|0
• edit: src/theme.css +2|0
• git commit: 1983fsdf34, a4c12de890
<assistant answer>
[ 27 actions · 508.4k prompt (28.2k fresh · 480.2k cached) · 1.3k received · 1h 20m 32s ] — 16:33
```

Сохраняются:

1. Успешные `write`/`edit` с проверенным `added > 0 || removed > 0`, а также подтверждённые создания и удаления пустых файлов с нулевыми line-counts.
2. Одна строка подтверждённых commit hashes, если включён `Retain Git rows`.
3. Одна configurable stats row под ответом, если включена статистика. Она появляется, когда сессия освободилась, и в контекст модели не попадает. Справа от неё — локальное время завершения ответа (`hh:mm`), если включён `Add local time`; при восстановлении истории показывается то же время, что и в момент ответа.

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

Native `edit` с `op: create` — это upsert, а его all-add diff не доказывает отсутствие старого файла. Плагин синхронно фиксирует bounded pre-image и сравнивает его с native `newText`: неизменённый файл не получает mutation row, overwrite учитывает удалённые строки. Неподтверждённый или pruned before/after не заменяется оценкой из all-add diff. `write` и `edit` разделяют canonical-target claims: пересекающаяся атрибуция отбрасывается, последующая непересекающаяся операция снова может дать exact evidence.

Если terminal `agent_end` приходит раньше, чем `tool_execution_end` успел забрать pending write/edit/git audit-запись, lifecycle сразу abandon'ит эти pending records (terminal purge). Drain всё равно settles, чтобы run финализировался, но для этого turn нет persisted `+N/−M` / Git evidence. Completions, которые уже in flight к моменту `agent_end`, ждутся до внутреннего порога ~5s; сам порог не вынесен в настройки. Это fail-closed by design: лучше не показать stats, чем выдумать их при lag или reordering host events.

Отложенное write-evidence сохраняет id исходной assistant/tool-start entry. При восстановлении UI carrier берётся из session journal только для ветви, содержащей именно эту source entry и соответствующий write. Поэтому поздняя публикация после `/tree` или следующего run не переносит счётчики на новую entry с тем же `toolCallId`. Native leaf/journal не переписываются, metadata не добавляются в модельный контекст. Старые carriers без source id остаются branch-local; уже сохранённая история автоматически не исправляется.

Если другой filesystem `write` начинает менять тот же canonical target до завершения первого audit, оба неоднозначных audit отбрасываются; это распространяется и на symlink aliases. Native записи не блокируются и выполняются как раньше, но run не получает неподтверждённые `+N/−M`. После завершения конфликтующих native вызовов и terminal drain следующая непересекающаяся запись снова может дать точный diff. Guard отслеживает filesystem write events одного plugin lifecycle, а не внешние процессы или отдельные экземпляры плагина.

Создание пустого файла — изменение существования, даже если before/after text пусты. Оно сохраняется как точное `+0|0` с отдельным признаком creation; успешное удаление пустого файла сохраняется как `delete ... -0`. Обычная перезапись существующего пустого файла и нулевой diff `edit` остаются no-op. Отложенное write-evidence также проверяет, что source entry ещё принадлежит текущему session journal: если native переключение уже заменило журнал, старый carrier туда не записывается.

На обычной ширине mutation-row сокращает только path, сохраняя полные счётчики. Если title и stats вместе уже не помещаются, stats выводятся на отдельных строках и при необходимости переносятся штатным ANSI-aware helper. Это действует и для legacy custom-message rows: финальная обрезка хоста не удаляет цифры справа.

Teardown происходит при новой сессии, non-fork switch либо shutdown; `/fork` сохраняет текущее состояние, потому что OMP не перестраивает transcript.

### Git summary

Git распознаётся консервативно из уже выполненного Bash command/result. Плагин не запускает скрытые `git log`, `rev-parse` или другие probes.

Отдельные вызовы и цепочки через `&&` дают Git evidence. Цепочки через `;` или неэкранированный перевод строки остаются обычным Bash: общий exit code не доказывает успех ранних команд. Переносы в quoted commit message и продолжения после `&&` поддерживаются. Для quiet commit следующий `git log` подтверждает hash только при одинаковых global Git args, `--oneline`, положительном лимите количества записей (если указан) и HEAD без фильтров, pathspecs или других revisions.

В режиме `live`:

- во время работы показываются распознанные Git rows, если `retainGitLive=true`;
- после ответа individual rows удаляются;
- в summary входят только успешные `git commit` records с доказанным hash;
- status/add/push/switch/rebase, failed commits и commits без hash в summary не входят;
- hashes сохраняют chronological order, newest hash остаётся видимым при узкой ширине.

`retainGitLive=false` скрывает Git rows и terminal commit summary в `live`. В `compact` полный Git log остаётся независимо от этого toggle. В `clear` ordinary Git rows скрыты вместе с остальными compact rows, но terminal commit summary остаётся и после abort/error: созданные commits — единственная evidence, которую тихий режим не прячет, иначе log утверждал бы, что ничего не произошло, там где история изменилась. При `retainGitLive=false` summary не остаётся и в `clear`.

## Настройки

Откройте интерактивное меню:

```text
/compact-settings
```

Управление:

- `↑`/`↓` или `k`/`j` — перемещение;
- `←`/`→` — смена режима;
- `Space`/`Enter` — toggle;
- `s` — сохранить;
- `Esc`, `c` или interrupt keybinding — закрыть без сохранения.
- на строке `Cycle shortcut` — `Enter` начинает ввод сочетания текстом, `Enter` подтверждает, `Esc` отменяет.

Открытие и отмена меню ничего не записывают. `enabled`, `mode`, `retainGitLive`, `compactPaths` и `compactVibeRows` фиксируются на границе logical run и не меняются в continuations. Stats toggles читаются при каждой отрисовке stats row, поэтому сохранение меню меняет и уже показанные stats rows.

### Горячая клавиша переключения вида

`alt+c` работает по умолчанию, включать её не нужно. Каждое нажатие делает один шаг по кругу:

```text
compact → live → clear → off → compact
```

Режим меняется только между тремя включёнными состояниями; признак включённости плагина переключается только на входе в `off` и на выходе из него. При выключении последний режим остаётся в config file, поэтому случайное нажатие ничего не теряет; при включении круг всегда начинается с `compact`, поэтому порядок не зависит от того, с какого места вы в него вошли.

Одновременные нажатия не объединяются и не теряют шаги: чтение config, вычисление следующего состояния и сохранение входят в общую save-очередь. Если перед keypress сохраняется dialog, цикл начинает со свежего результата dialog, а не затирает его старым snapshot.

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
| `Advisor nit/concern` / `compactAdvisorNotes` | `false` | Сворачивает non-blocking заметки советника (`nit`/`concern`) в одну строку на заметку. `blocker`, неизвестные severity и нечитаемые `details` оставляют карточку OMP; развёрнутая карточка всегда полная. |
| `Cycle shortcut` / `displayCycleKey` | `"alt+c"` | Сочетание, переключающее вид вывода по кругу. Занятое OMP сочетание отклоняется при вводе. Смена требует restart OMP. |
| `Run statistics` / `stats.enabled` | `true` | Включает terminal stats row. |
| `Actions` / `stats.actions` | `true` | Число distinct tool executions, включая failures и unmapped tools. |
| `Fresh input` / `stats.sent` | `true` | Сумма `usage.input` уникальных assistant completions — свежие, некэшированные токены входа. |
| `Received tokens` / `stats.received` | `true` | Сумма `usage.output`. |
| `Cached tokens` / `stats.cache` | `true` | `cacheRead / (sent + cacheRead)` и число кэш-токенов; вместе с свежими и записями кэша даёт полный prompt. |
| `Time` / `stats.time` | `true` | Wall time от `agent_start` до terminal `agent_end`. |
| `Add local time` / `stats.clock` | `true` | Локальное время завершения ответа (`hh:mm`) справа от строки, за скобками. Берётся из момента terminal `agent_end`, поэтому restored history показывает время самого ответа, а не время перерисовки. |

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
    "time": true,
    "clock": true
  }
}
```

Ограничения parser/store:

- размер не больше 65,536 bytes;
- native read проверяет regular file и размер открытого descriptor до чтения; `O_NONBLOCK` не даёт writer-less FIFO остановить startup/load/save, а exact-size read ограничен размером плюс один байт и отклоняет growth/shrink;
- nesting depth не больше 16;
- поддерживается только `version: 1`;
- invalid fields получают defaults и вызывают одно предупреждение;
- запись выполняется через temporary file и same-directory atomic rename;
- очередь writers — только in-process: disjoint edits в одном процессе сливаются leaf-патчем, а writers в разных OS processes на одном JSON path остаются last-writer-wins (без lock file; atomic rename не даёт torn reads).


### Environment overrides

| Variable | Значения | Эффект |
| --- | --- | --- |
| `OMP_COMPACT_PLUGIN` | `0` или `false` | Hard-disable runtime. Settings command остаётся доступной. Другие значения не форсируют включение. |
| `OMP_COMPACT_MODE` | `compact`, `live`, `clear` | Переопределяет persisted mode. |
| `OMP_COMPACT_MODE` | `off` | Legacy hard-disable runtime. |
| `OMP_COMPACT_CONFIG` | path | Переопределяет путь config file; путь должен быть внутри home или project cwd, иначе он игнорируется с предупреждением. |

Runtime precedence:

1. `OMP_COMPACT_PLUGIN=0|false` и `OMP_COMPACT_MODE=off` выключают runtime.
2. `OMP_COMPACT_MODE=compact|live|clear` переопределяет persisted mode.
3. Остальные значения берутся из JSON.
4. При отсутствии валидного JSON используются defaults.

Menu save не записывает env overrides в JSON. Если env маскирует только что сохранённое значение, меню сохраняет requested value, и одна notification сообщает сразу оба факта: сохранение выполнено и какая variable удерживает effective value (например, `omp-compact settings saved; effective mode remains live because OMP_COMPACT_MODE=live`).

Config-файлы 1.x могут содержать группы `autoShake` и `host`. Они загружаются без ошибок: плагин их больше не читает и сохраняет как unknown keys.

## Project-relative paths

При `compactPaths=true` absolute path строго внутри session `cwd` показывается относительно него:

```text
/Volumes/work/project/src/index.ts:10-20
-> src/index.ts:10-20
```

Это только display projection. Аргументы native tool, filesystem audit и persisted evidence не изменяются.

Каждый run сохраняет собственные `cwd` и `compactPaths` при создании. Новый run не меняет пути предыдущих строк при resize/перерисовке; заново восстановленная история получает текущие настройки. Этот UI snapshot не добавляется в session journal.

Известное ограничение: плагин знает вызов только по `toolCallId`. Некоторые провайдеры нумеруют вызовы заново в каждом ответе (`call_0`), и если следующий run повторит id, старый блок рисуется как вызов нового run. Из истории `compact` он может пропасть, когда закончится повторивший id run в `live`.

Без изменений остаются:

- paths вне `cwd` и похожие prefix paths с другой segment boundary;
- уже relative paths;
- URIs;
- archive/SQLite selectors и query suffixes;
- значения с `..`;
- paths на другом volume.

Line/raw/conflict selectors после `:` сохраняются byte-for-byte.

## Presentation routes

Compact output применяется только к явно зарегистрированным structured shapes.

| Route | Tools |
| --- | --- |
| `read-group` | `read` |
| `compact` | `bash`, `write`, `edit`, `grep`, `glob`, `find`, `hub`, `todo`, `eval`, `yield`, `hus`, `web_search`, `ast_grep`, `ast_edit`, `inspect_image`, `browser`, `computer`, `resolve`, `reject`, `task`, `vibe_spawn`, `vibe_send`, `vibe_wait`, `vibe_kill`, `vibe_list` |
| `native-live` | `ask` |

Aliases нормализуются до routing и audit: `apply_patch` -> `edit`, `jfind` -> `find` (модуль семантического поиска в хосте называется `jfind`); hyphen spellings вроде `ast-grep`, `ast-edit` и `inspect-image` -> underscore form.

OMP спрашивает про каждое чтение сгруппированной read-карточки отдельно, и каждое получает свою compact row. Развёрнутый блок (`Ctrl+O` или переключатель в Tern) всегда рисуется полной карточкой OMP, для любого инструмента, включая `browser`, `computer`, `resolve` и `reject`, которые раньше оставались compact и в раскрытом виде.

Unknown tool не получает compact row плагина. Он получает однострочную сводку самого OMP во всех phases, включая `clear`: новый или third-party tool не скрывается и описан renderer'ом самого инструмента.

Registry использует только structured tool name, args и result блока. Rendered/ANSI text не парсится для определения tool identity.

### Вызовы внешних устройств

Часть инструментов вызывается через транспорт записи: адрес `xd://<устройство>` вместо пути к файлу, а аргументы вызова лежат в теле записи. Такая строка показывает само устройство заголовком и его операцию описанием (`github` -> `pr_create`, `security_scan` -> `preflight`), а не транспортный путь: `write: xd://github` читалось бы как запись в несуществующий файл. Операция берётся из structured args вызова — из написания `op` или `action`; устройство без операции печатает только имя, без заглушек. Если тело вызова ещё не дописано, не разбирается как JSON-объект или превышает бюджет разбора, строка тоже остаётся с одним именем устройства, а операция появляется из подтверждённых аргументов результата, когда вызов завершится.

Текстовые устройства (`resolve`, `reject`, `propose`, `report_issue`) несут не JSON-аргументы, а короткую причину, поэтому получают оформление resolution: собственный заголовок и цвет, причина описанием, action и источник в settled metadata.

Вызов устройства не является изменением файла и в mutation audit не попадает: адрес — транспортный, а не путь к файлу, поэтому такой вызов не заводит write-запись и не может приписать локальную правку файла обращению к устройству. Обычная запись файла продолжает проходить полный pre/post audit без изменений.

### Параллельные рабочие сессии

Пять инструментов управления worker sessions (`vibe_spawn`, `vibe_send`, `vibe_wait`, `vibe_kill`, `vibe_list`) вместо stock framed «TV wall» получают собственную compact grammar: одна-две строки на сессию.

Строка сессии собирается из известных полей snapshot: glyph состояния, badge вида worker (`⟦f⟧` / `⟦g⟧`), имя сессии, число ходов и глубина очереди (`3t+2q`), длительность текущего хода, короткое имя модели и текст последней активности либо текущего инструмента. `vibe_wait` обновляет свои строки на каждом промежуточном результате, пока ожидание блокирует: OMP спрашивает presenter заново при каждом изменении данных блока.

`vibe_list` печатает заголовок `vibe sessions N` со числом скрытых сессий, если такие есть. `vibe_wait` печатает заголовок с числом сессий в работе и числом settled, а при истёкшем окне ожидания — пометку `timed out`; заголовок опускается, когда напечатана ровно одна карточка. Пустой набор строк — законный исход: `vibe_kill` не печатает ничего. Мёртвые сессии, снятые и упавшие ходы выпадают по короткому TTL, который отсчитывается от момента завершения вызова, поэтому завершённый вызов рисуется одинаково при каждой перерисовке.

Раскрытый вызов показывает полную карточку OMP. Ошибка вызова печатается одной строкой `✘` с целью вызова и текстом ошибки.

Compact grammar управляется настройкой `vibe-compact` / `compactVibeRows` (по умолчанию включена). При `false` все пять инструментов рисуются полной карточкой OMP так, как если бы плагин их не знал. Флаг фиксируется на границе logical run вместе с mode, поэтому сохранение меню посреди прогона не меняет картинку на полпути.


### Заметки советника (advisor notes)

Карточка советника (`customType: "advisor"`) приходит в presenter как message-блок вместе с `details` сообщения. Плагин читает заметки из `details` и сворачивает карточку только тогда, когда может прочитать их все.

- **Opt-in.** Настройка `Advisor nit/concern` / `compactAdvisorNotes` по умолчанию выключена: при апгрейде ничего не меняется само собой. После сохранения настройки плагин просит OMP перерисовать карточки советника.
- **Сворачиваются только non-blocking заметки**: `nit`, `concern` и отсутствующий severity (host документирует его как plain nit). Одна строка на заметку.
- **Всё остальное остаётся карточкой OMP.** `blocker`, неизвестный severity, нечитаемые `details` или больше 64 заметок: карточка рисуется целиком, как её рисует OMP.
- **Раскрытие всегда выигрывает.** Развёрнутая карточка показывает полную карточку OMP.
- **Ничего не мутируется.** Сообщение, `details`, сессия и контекст модели не переписываются.

Строка компактного вида:

```text
• advisor [nit] Keep the concise label
• advisor [concern] [Luna] Check the transaction boundary
```

## Почему архитектура plugin-only

### Native tools не переопределяются

Повторная регистрация built-ins потребовала бы копировать schemas, approval и concurrency metadata либо делегировать execution через другой context. Такой wrapper легко расходится с host и может ослабить safety contract. `omp-compact` оставляет оригинальный `AgentTool` установленным и меняет только presentation/audit поверх stock events.

### Публичный presenter вместо патчей

OMP 18.17 даёт extensions `pi.registerTranscriptPresenter`: на каждый блок transcript OMP спрашивает presenter, как его рисовать, и рисует ответ сам, в терминале и в нативном представлении Tern. Плагин не трогает классы OMP. Ответ зависит только от данных блока и от session ledger плагина, ключом которого служит `toolCallId`; когда состояние плагина меняется (ответ получен, evidence пришло, щелчок по stats row), он просит OMP перерисовать нужные блоки через `ctx.ui.refreshTranscript(ids)`.

### Terminal boundary важнее отдельного tool result

Успешный tool может быть промежуточным шагом. Если удалить его строку на `tool_execution_end`, пользователь потеряет контекст, пока модель продолжает работу. Поэтому run в session ledger живёт от `agent_start` до terminal `agent_end`, а фильтрация выполняется один раз после готового ответа.

### Audit отделён от renderer

Renderer отвечает за строки. `AuditLifecycle` отвечает за bounded pre/post evidence, `git-records.ts` — за conservative Git parsing, `SessionLedger` — за runs и retention. Typed registry лишь выбирает presentation route и audit kind. Он не читает filesystem, не разбирает Git и не управляет lifecycle.

## Основные модули

| Файл | Ответственность |
| --- | --- |
| `index.ts` | Extension entrypoint, events, command и session wiring. |
| `presenter.ts` | Transcript presenter: ответ OMP для каждого блока. |
| `session-ledger.ts` | Runs, calls и evidence по `toolCallId`; walk ветви сессии при resume и rebuild. |
| `leaf-views.ts` | Компактные view для не-tool блоков (TTSR, todo reminder, skill, late diagnostics, `!`/`$`, advisor) из их structured data. |
| `native-text.ts` | ANSI-строка плагина → `TspText` для OMP и Tern. |
| `idle-queue.ts` | Работа, ждущая idle сессии (отправка stats row). |
| `tool-presentation-rules.ts` | Typed routes, aliases, audit selectors и known structured shapes. |
| `tool-rule-describers.ts` | Pure describer-поведение правил: describe/resultMeta, текстовые устройства и hub launch-зеркало. |
| `render-decision.ts` | Pure mode/route projection decisions. |
| `render.ts` | Row construction: mutations, git, stats и vibe rows. |
| `turn-ledger.ts` | Классификация `agent_end` и terminal phases. |
| `audit.ts`, `audit-diff.ts`, `audit-lifecycle.ts` | Bounded file-mutation evidence и async lifecycle. |
| `git-records.ts` | Conservative Git command/result classification. |
| `vibe-cards.ts`, `vibe-cards-decode.ts`, `vibe-cards-render.ts`, `vibe-cards-slots.ts` | Compact rows для параллельных worker sessions. |
| `config.ts`, `mode-policy.ts` | Persistent config и immutable run snapshot. |
| `settings-ui.ts`, `settings-dialog.ts`, `settings-keys.ts`, `save-flow.ts`, `cycle-handler.ts` | Settings dialog, display cycle и сохранение. |
| `host-api.ts` | Структурные host API типы и регистрация command/shortcut. |
| `ansi-width.ts` | ANSI-SGR-safe strip и truncate. |
| `run-stats.ts` | Usage aggregation, persisted evidence и stats row. |
| `display-path.ts` | Display-only project-relative paths. |

## Troubleshooting

### `/compact-settings` отсутствует

- Убедитесь, что загружен `index.ts`, а рядом находятся остальные `.ts` files плагина.
- Проверьте alternative command names `/omp-compact-settings` и `/omp-compact-settings-N`.
- Для project discovery запускайте OMP из того же directory, где находится `.omp`.
- Проверьте, что runtime — OMP 18.17 или новее.

### Меню сообщает, что нужен interactive terminal

`ctx.ui.custom()` недоступен в headless/RPC context. Plugin-only settings можно изменить через JSON file; in-process store updates (включая `/compact-settings` save) применяются на следующей границе logical run. Ручная правка JSON вне процесса подхватывается на следующей границе сессии, а не автоматически mid-session.

### Сохранённая настройка не действует

Проверьте `OMP_COMPACT_PLUGIN` и `OMP_COMPACT_MODE`. Env overrides имеют приоритет над JSON. Runtime changes через store применяются на следующей границе logical run.

### Все блоки рисуются штатными карточками OMP

Включите `/settings → Tools → Extensions → Extension Transcript Presenters`. Пока эта настройка OMP выключена, OMP не спрашивает presenter плагина, и после первого вызова инструмента плагин один раз показывает предупреждение с этим путём.

### Вместо compact rows видна полная карточка OMP

Так задумано для развёрнутого блока (`Ctrl+O` или переключатель в Tern), интерактивного `ask` и `vibe_*` при `compactVibeRows=false`. Неизвестный инструмент получает однострочную сводку самого OMP. Если полные карточки видны у всех известных инструментов, проверьте настройку `Extension Transcript Presenters` и версию OMP.

### Path остался absolute

Сокращаются только absolute filesystem paths строго внутри captured session `cwd`. External paths, URIs, selectors с неподходящим base и небезопасные `..` остаются без изменений.

### Mutation row исчезла после ответа

В `live` остаются только successful, verified и non-zero mutations. No-op, failed, oversized, mismatched или неподтверждаемая operation не получает долговременную exact row.

### Git summary отсутствует

Проверьте `retainGitLive`, режим и result команды. Summary создаётся в `live` после успешного ответа и в терминальном `clear` (включая abort/error) только для successful commit records с подтверждённым hash. `compact` сохраняет individual Git rows вместо aggregate summary. Цепочки через `;`/неэкранированный newline и quiet logs с фильтрами, другим revision или другим контекстом Git не подтверждают hash.

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

Проверяйте как минимум (с включённой настройкой `Extension Transcript Presenters`):

- `compact`, `live`, `clear`;
- successful `/tree` navigation и resume, затем ещё один live tool run в той же сессии;
- settings save/reopen;
- successful answer и abort/error без ответа;
- no-op и non-zero `write`/`edit`;
- successful/hashless/failed Git operations;
- stats fields, error color и щелчок по stats row в Tern;
- unknown tool (однострочная сводка OMP) и `Ctrl+O` на скрытом вызове (полная карточка).
