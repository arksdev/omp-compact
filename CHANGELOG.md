# Changelog

All notable changes to `omp-compact` are documented in this file.
Все значимые изменения `omp-compact` документируются в этом файле.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow [Semantic Versioning](https://semver.org/).
Формат соответствует [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), а выпуски следуют [семантическому версионированию](https://semver.org/).

## [Unreleased]

### Changed

- Delete operations now render as distinct red `delete` rows (red title, gray path, red exact removed stat) instead of `edit` rows with a `+0|N` pair; when the exact removed count is unavailable the stat is omitted entirely, never estimated.
- Операции удаления теперь отображаются отдельными красными строками `delete` (красный заголовок, серый путь, красная точная статистика удалённых строк) вместо строк `edit` с парой `+0|N`; когда точное количество удалённых строк недоступно, статистика не выводится вовсе, а не оценивается.
- A delete with a valid path but no exact pre-image (oldText missing/pruned/oversized) is now retained as a count-less `delete` row instead of being dropped: the path is real evidence, an unknown count is never approximated, and aggregate exactness is demoted when such a row is present.
- Удаление с валидным путём, но без точного pre-image (oldText отсутствует/обрезан/слишком велик) теперь сохраняется как строка `delete` без статистики вместо полного отбрасывания: путь — реальное свидетельство, неизвестное количество никогда не оценивается, а точность агрегата понижается при наличии такой строки.
- `genericToolDescription`, `stringValue`, and `listValue` now truncate at code-point boundaries (mirroring `sanitizeOneLine`), so long arguments never split a surrogate pair; the `genericToolDescription` JSDoc now states its real routing (generic form for tools without a specialized describe).
- `genericToolDescription`, `stringValue` и `listValue` теперь усекают по границам code point'ов (как `sanitizeOneLine`), поэтому длинные аргументы никогда не разрывают суррогатные пары; JSDoc `genericToolDescription` теперь описывает реальную маршрутизацию (общая форма для инструментов без специализированного describe).

## [1.0.3] - 2026-08-14

### Fixed

- Delayed `message_update` events from a previous logical run can no longer contaminate the next run's compact state or force its tools back to the native surface; only the actively streaming working ledger is touched, and `tool_execution_start` remains the sole state allocator.
- Задержанные события `message_update` предыдущего логического хода больше не могут загрязнять компактное состояние следующего хода или возвращать его инструменты к нативному виду: обрабатывается только активно стримящийся working ledger, а единственным аллокатором состояний остаётся `tool_execution_start`.
- Auto-shake now runs only after the audit evidence drain completes successfully; a failed or abandoned drain (barrier timeout, session switch, or shutdown) skips the shake instead of pruning tool results whose evidence rows were never persisted.
- Автоматический shake теперь выполняется только после успешного завершения сбора аудит-свидетельств; при неудавшемся или прерванном сборе (таймаут барьера, переключение или завершение сессии) shake пропускается, а не удаляет результаты инструментов, строки свидетельств для которых так и не были сохранены.
- A failed plugin JSON save now compensates an already-successful host settings apply by restoring the exact raw persistent pre-image of the changed host paths, including removed keys, so the host side never diverges from the unchanged plugin config.
- При неудачном сохранении plugin JSON теперь компенсируется уже успешно применённая запись настроек хоста: восстанавливается точный raw persistent pre-image изменённых путей, включая удалённые ключи, поэтому сторона хоста никогда не расходится с неизменённым конфигом плагина.
- The synchronous write pre-image read now opens with `O_NONBLOCK` and rejects every non-regular target (FIFO, device, socket, directory) fail-open via `fstat` of the opened descriptor, so a model-controlled path can no longer block the main event loop; symlink-to-regular snapshots and all size/read bounds stay exact.
- Синхронное чтение пре-образа записи теперь открывает файл с `O_NONBLOCK` и отклоняет любые нерегулярные цели (FIFO, устройство, сокет, каталог) по `fstat` открытого дескриптора (fail-open), поэтому управляемый моделью путь больше не может блокировать главный цикл событий; снимки symlink-на-регулярный-файл и все ограничения размера/чтения остаются точными.
- A terminal run whose audit drain failed is now finalized as full when its deferred claim releases, so the old run's ledger and spinner states can never stay working forever after the next run began; the release requests a render of exactly that ledger with no stats, evidence, or auto-shake side effects.
- Логический ход, чей аудит-дрейн завершился неудачей, теперь финализируется как full в момент освобождения отложенного claim'а, поэтому леджер старого хода и его состояния спиннера не могут навсегда остаться working после начала следующего хода; release запрашивает рендер ровно этого леджера без побочных эффектов статистики, свидетельств или авто-shake.
- A malformed, oversized, or unreadable persisted config now fails the save closed: `update()` re-reads strictly before the atomic rename and throws `ConfigUpdateError`, leaving the broken file byte-for-byte untouched instead of silently collapsing it to defaults; only a genuinely missing file (ENOENT) falls back to defaults, while `load()` stays fail-open so the runtime always boots.
- Повреждённый, слишком большой или нечитаемый сохранённый конфиг теперь приводит к закрытому сбою сохранения: `update()` строго перечитывает файл перед атомарным rename и бросает `ConfigUpdateError`, оставляя повреждённый файл байт-в-байт нетронутым вместо молчаливого сведения к значениям по умолчанию; только действительно отсутствующий файл (ENOENT) даёт fallback на значения по умолчанию, а `load()` остаётся fail-open, чтобы рантайм всегда запускался.
- Live mutation evidence now respects the persisted batch cap: `setMutations` demotes exactness over a truncated batch and never mutates the caller's array.
- Живые свидетельства изменений теперь учитывают ограничение размера пакета: `setMutations` понижает точность при усечённом пакете и никогда не мутирует массив вызывающей стороны.
- `sanitizeOneLine` and `truncateAnsiSafe` truncate at code-point boundaries, so long tool output never splits a surrogate pair; settings reset semantics are unchanged.
- `sanitizeOneLine` и `truncateAnsiSafe` усекают по границам code point'ов, поэтому длинный вывод инструментов никогда не разрывает суррогатные пары; семантика сброса настроек не изменилась.
- `gitLine` strips exactly one leading error icon, so an errored Git row never renders a duplicated ✗.
- `gitLine` удаляет ровно одну ведущую иконку ошибки, поэтому строка Git с ошибкой никогда не отображает задвоенный ✗.
- `commitDetails` keeps the commit hash for subject-less commit rows and omits the subject when absent.
- `commitDetails` сохраняет хэш коммита для строк без subject'а и опускает subject, когда его нет.
- Git recognition accepts the short pager flags `-p`/`-P` alongside `--paginate`/`--no-pager`.
- Распознавание Git принимает короткие флаги пейджера `-p`/`-P` наряду с `--paginate`/`--no-pager`.
- Tool execution updates and completions delivered after their run's ledger finalized — or while a terminal run awaits its audit drain — are now ignored: a late `tool_execution_update`/`tool_execution_end` can no longer rewrite the settled run's state, resurrect a spinner row, or bump its presentation version, while events of working and continuation runs behave exactly as before.
- Обновления и завершения выполнения инструментов, доставленные после финализации леджера хода — или пока терминальный ход ожидает аудит-дрейн — теперь игнорируются: поздние `tool_execution_update`/`tool_execution_end` больше не могут перезаписать состояние завершённого хода, возродить строку спиннера или изменить версию его представления, тогда как события working- и continuation-ходов работают как раньше.
- A bounded settings save no longer strips config keys this schema does not know: the leaf patch is applied onto the raw parsed record, so unknown top-level and nested keys survive the update verbatim, known fields stay validated, malformed/unsafe files still fail closed, the merged result is re-checked against the size/depth bounds before the atomic write, and the persisted record always declares its `version: 1` schema marker even when a legacy file lost it.
- Ограниченное сохранение настроек больше не удаляет неизвестные схеме ключи конфига: leaf-патч применяется к «сырой» записи, поэтому неизвестные top-level и вложенные ключи переживают обновление дословно, известные поля по-прежнему валидируются, повреждённые/небезопасные файлы по-прежнему отклоняются, итоговый результат перед атомарной записью повторно проверяется на ограничения размера/глубины, а сохранённая запись всегда объявляет маркер схемы `version: 1`, даже если legacy-файл его потерял.
- The settings dialog now keeps the focused row visible on short terminals: it reads the live terminal height from the host TUI handed to `ui.custom` and renders a focus-centered viewport (header, error, and help stay pinned; clipped edges show the dim `…` marker), following the host's own `SettingsList` scroll model instead of letting the bottom-anchored window silently cut off the upper rows.
- Диалог настроек теперь держит сфокусированную строку видимой на низких терминалах: он читает живую высоту терминала из host TUI, передаваемого в `ui.custom`, и рисует viewport с центрированием на фокусе (заголовок, строка ошибки и help остаются закреплёнными; обрезанные края помечаются тёмным `…`), следуя модели прокрутки `SettingsList` самого host'а вместо того, чтобы прижатое к низу окно молча срезало верхние строки.
- Overlapping settings saves now serialize per target: each save runs to completion — host apply, JSON persist, and on failure its compensating rollback — before the next one starts, so a concurrent save no longer loses its arguments to the bridge's apply coalescing and a failed save's rollback can never restore a state that predates another save's already-successful write.
- Перекрывающиеся сохранения настроек теперь сериализуются по цели: каждое сохранение выполняется полностью — применение на хосте, запись JSON и, при неудаче, компенсирующий rollback — прежде чем начнётся следующее, поэтому параллельное сохранение больше не теряет свои аргументы из-за коалесцирования `apply` в bridge, а rollback неудавшегося сохранения не может восстановить состояние, предшествующее уже успешной записи другого сохранения.

## [1.0.2] - 2026-08-13

### Fixed

- Fixed an issue where, after compaction in long sessions, the plugin could lose track of a logical run, stop reporting statistics, and switch tool output back to the native view.
- Исправлена ошибка, из-за которой в длинных сессиях после компакта плагин мог терять отслеживание одного логического хода, не выводить статистику и переключать вывод инструментов на нативный вид.

### Changed

- Rendered `browser`, `computer`, `resolve`, and `reject` as compact one-line tool rows; highlighted only the requested tool labels, kept payloads neutral, and preserved `ask` as the native interactive surface.
- Инструменты `browser`, `computer`, `resolve` и `reject` переведены в компактные однострочные строки: выделяются только названия, payload остаётся нейтральным, а `ask` сохраняет нативную интерактивную поверхность.
- Moved the pinned development and release-gate host to stock OMP 17.3.1 while retaining the public `>=17.2.12` compatibility floor; added a stock-host canary for container-owned tool-activity visibility forwarding.
- Закреплённый development/release host переведён на штатный OMP 17.3.1 при сохранении публичного порога совместимости `>=17.2.12`; добавлен stock-host canary для container-owned forwarding видимости tool activity.

## [1.0.1] - 2026-08-12

### Changed

- Corrected public architecture limits, extension examples, upgrade instructions, and contributor verification guidance.
- Уточнены публично задокументированные ограничения архитектуры, примеры расширений, инструкции по обновлению и рекомендации по проверке изменений для участников проекта.
- Normalized all 11 public replay fixtures and golden projections to remove raw session provenance, machine paths, timestamps, worker labels, internal namespaces, and long tool-call identifiers while preserving behavioral coverage.
- Нормализованы все 11 публичных фикстур воспроизведения и эталонных проекций: удалены необработанные данные о происхождении сессий, пути локальной машины, временные метки, метки воркеров, внутренние пространства имён и длинные идентификаторы вызовов инструментов при сохранении поведенческого покрытия.
- Made replay regeneration manifest-driven through an external untracked `OMP_REPLAY_MANIFEST` and added regression contracts preventing provenance reintroduction.
- Регенерация данных воспроизведения переведена на внешний неотслеживаемый манифест `OMP_REPLAY_MANIFEST`; добавлены регрессионные контракты, предотвращающие повторное появление данных о происхождении сессий.
- Enabled `noUnusedLocals`, removed the discovered dead audit local, and made publication-layout checks inspect Git-tracked paths rather than harmless local ignored directories.
- Включён `noUnusedLocals`, удалена обнаруженная неиспользуемая локальная переменная аудита, а проверки структуры публикации теперь анализируют отслеживаемые Git пути вместо безвредных локальных игнорируемых каталогов.
- Added before/after GIF demonstrations to both READMEs, linked to their original MP4 recordings.
- В оба README добавлены GIF-демонстрации «до/после» со ссылками на исходные MP4-записи.

### Verified

- Stock OMP 17.2.12 release gate: 774 tests, 0 failures, and 3,928 assertions across 28 files.
- Проверка релиза на штатном OMP 17.2.12: 774 теста, 0 ошибок и 3 928 утверждений в 28 файлах.
- Strict TypeScript, Biome lint/format, Markdown links, package payload, and Marketplace dry-run checks.
- Пройдены строгая проверка TypeScript, lint и format Biome, проверка ссылок Markdown, содержимого пакета и пробный запуск Marketplace.

## [1.0.0] - 2026-08-12

### Added

- Three presentation modes: `compact`, `live`, and `clear`.
- Три режима представления: `compact`, `live` и `clear`.
- Evidence-based mutation audit for native `write` and `edit` tools.
- Аудит изменений, основанный на фактических данных, для нативных инструментов `write` и `edit`.
- Conservative Git detection with a terminal aggregate commit summary.
- Консервативное обнаружение Git с итоговой агрегированной сводкой коммита в терминале.
- Configurable terminal usage statistics and project-relative display paths.
- Настраиваемая статистика использования терминала и отображение путей относительно проекта.
- Opt-in post-turn auto-shake through the stock public session API.
- Опциональный автоматический shake после хода через штатный публичный API сессии.
- Persistent `/compact-settings` UI, environment overrides, and atomic config updates.
- Постоянный интерфейс `/compact-settings`, переопределения через переменные окружения и атомарные обновления конфигурации.
- Same-session reconstruction after `/tree` and manual `/shake` without restarting OMP.
- Восстановление в той же сессии после `/tree` и ручного `/shake` без перезапуска OMP.
- Redacted replay corpus plus focused and stock-host integration coverage.
- Очищенный от чувствительных данных корпус воспроизведения, а также сфокусированные интеграционные тесты и тесты на штатном хосте.

### Fixed

- Reject duplicate `TranscriptFold` ownership when the same checkout is loaded through both a user-installed symlink and an explicit `-e` path, preventing recursive finalization and stack overflow.
- Запрещено дублирующее владение `TranscriptFold`, когда одна и та же рабочая копия загружается одновременно через установленную пользователем символьную ссылку и явный путь `-e`, что предотвращает рекурсивную финализацию и переполнение стека.
- Run the source-checkout launcher with isolated extension discovery so it cannot double-load an ambient `omp-compact` installation.
- Лаунчер из исходной рабочей копии запускается с изолированным обнаружением расширений, поэтому он не может повторно загрузить уже установленный в окружении `omp-compact`.

### Hardened

- Exact-instance, reversible host patches with capability checks and native fail-open fallback.
- Обратимые патчи хоста, привязанные к точным экземплярам, с проверками возможностей и нативным fail-open поведением.
- Bounded config parsing, hydration, mutation evidence, and diff processing.
- Ограниченная по объёму обработка конфигурации, гидратации, свидетельств изменений и diff-данных.
- Delayed terminal audit ownership and statistics-carrier ancestry across subsequent runs.
- Отложенное владение аудитом терминала и сохранение иерархии носителей статистики в последующих запусках.
- Capability-checked stats-carrier placement and immediate JSON structural-underflow rejection.
- Размещение носителей статистики с проверкой возможностей и немедленное отклонение структурно неполного JSON.

### Changed

- Reworked the repository README around marketplace installation, plain-language behavior, mode differences, additional settings, safe removal, and English/Russian navigation.
- README репозитория переработан вокруг установки через Marketplace, понятного описания поведения, различий режимов, дополнительных настроек, безопасного удаления и навигации между английской и русской версиями.
- Changed the opt-in auto-shake threshold default from 2,000,000 to 120,000 tokens; `0` still means every eligible logical run.
- Значение по умолчанию для опционального порога auto-shake изменено с 2 000 000 до 120 000 токенов; `0` по-прежнему означает каждый подходящий логический ход.
- Declared public compatibility as OMP 17.2.12 and later while keeping stock 17.2.12 as the pinned release-gate host; future incompatible TUI shapes fail open to native rendering.
- Публично заявлена совместимость с OMP 17.2.12 и новее, при этом штатный OMP 17.2.12 остаётся закреплённым хостом проверки релиза; будущие несовместимые формы TUI безопасно переключаются на нативный рендеринг.

### Verified

- Stock OMP 17.2.12 compatibility as the pinned release gate for the public `>=17.2.12` support range.
- Подтверждена совместимость со штатным OMP 17.2.12 как закреплённым хостом проверки релиза для публично поддерживаемого диапазона `>=17.2.12`.
- 772 tests, 0 failures, and 3,912 assertions across 28 files in the standalone release gate.
- В автономной проверке релиза пройдено 772 теста без ошибок и выполнено 3 912 утверждений в 28 файлах.
- Strict TypeScript and Biome checks.
- Пройдены строгие проверки TypeScript и Biome.
- Persistent-session manual smoke covering prior-session resume, all three modes, `/tree`, `/shake`, and new live tool calls after both reconstruction paths.
- Проведена ручная smoke-проверка постоянной сессии: возобновление предыдущей сессии, все три режима, `/tree`, `/shake` и новые живые вызовы инструментов после обоих путей восстановления.

### Compatibility

- The plugin supports OMP 17.2.12 and later; its known private TUI shape and executable release gate are pinned to stock 17.2.12.
- Плагин поддерживает OMP 17.2.12 и новее; известная приватная форма TUI и исполняемый хост проверки релиза закреплены на штатной версии 17.2.12.
- A future incompatible host shape rolls back the presentation adapter, leaves native rendering active, and should be reported with the exact OMP version and reproduction.
- При будущей несовместимой форме хоста адаптер представления откатывается, оставляет активным нативный рендеринг; о таком случае следует сообщить с точной версией OMP и сценарием воспроизведения.

[Unreleased]: https://github.com/arksdev/omp-compact/compare/v1.0.3...HEAD
[1.0.3]: https://github.com/arksdev/omp-compact/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/arksdev/omp-compact/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/arksdev/omp-compact/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/arksdev/omp-compact/releases/tag/v1.0.0
