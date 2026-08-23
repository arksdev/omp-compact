# История изменений omp-compact

Простыми словами — что менялось для человека, который работает в OMP с этим плагином.

---

## Не выпущено

### Исправлено

- В диалоге настроек снова работают стрелки — в том числе в терминалах, которые присылают их не так, как большинство: раньше в таких терминалах курсор двигался только клавишами `j` и `k`. Спасибо [**@materemias**](https://github.com/materemias)
- Сочетания со стрелками, где зажат модификатор (Shift, Alt, Ctrl), больше не двигают курсор и не переключают значения.
- После того как контекст автоматически встряхивался, завершённые чтения перестали скрываться и разворачивались обратно в полные карточки. Теперь после встряски вид законченного хода остаётся таким же, каким он был до неё.
- При возвращении в сохранённую сессию история снова показывается компактно. Раньше восстановленные чтения разворачивались в полные карточки, если агент размышлял или отвечал между двумя чтениями одного хода, — а так бывает почти всегда.
- Сообщения о завершении фоновых процессов и заданий больше не разрывают компактный лог пустыми строками сверху и снизу: такая строка встаёт вплотную к соседним и уходит вместе с остальной рутиной, когда шаг закончен.
- Возобновление сессии больше не показывает рутину ходов, которые уже закончились ответом. Раньше восстановленная история всегда разворачивалась полным журналом, даже если выбран вид, где такая рутина убирается: на экране оставались чтения, поиски и команды из ходов, ответ на которые был получен давно. Теперь восстановленная история выглядит так же, как сразу после ответа в выбранном виде, а полный журнал остаётся у тех, кто его и выбрал.
- Спокойный вид больше не оставляет на экране рутину прерванного или упавшего хода: чтения, поиски и команды такого хода теперь уходят так же, как после обычного ответа. Раньше стоило прервать агента или получить ошибку — и на экране оставался полный журнал хода, хотя выбран был именно тот вид, где рутины не должно быть. Разбирать незавершённую работу по-прежнему удобно в двух других видах, а строка с хешами созданных коммитов остаётся и на прерванном ходе.
- В спокойном виде из восстановленной истории пропали и сообщения о завершении фоновых заданий. Раньше такая строка оставалась единственной посреди убранной истории, потому что не было понятно, какому ходу она принадлежит; теперь она подчиняется выбранному виду, как и всё остальное.

### Добавлено

- Появилась горячая клавиша `alt+c`, которая по кругу переключает вид вывода: компактный, живой, очищающий, выключенный плагин и снова компактный. Диалог настроек для этого открывать не нужно, а после нажатия печатается одна строка о том, что применится. Переключение вступает в силу с начала следующей работы агента, а при выключении последний выбранный вид сохраняется. Само сочетание можно сменить в настройках на любое незанятое — оно начнёт работать после перезапуска OMP.

### Изменено

- Работа в режиме `/vibe` стала компактнее: вместо уже убитых или простаивающих сабагентов выводятся только активные. На каждую сессию приходится одна-две короткие строки — состояние, имя, сколько ходов сделано, сколько идёт текущий, какая модель и чем сессия занята прямо сейчас.
- Короткий вид параллельных рабочих сессий в режиме `/vibe` стал отдельным переключателем. По умолчанию он включён; если выключить — эти сессии снова показываются штатными карточками OMP.
- Сообщение о завершении запущенного процесса теперь показывает сам OMP — плагин больше не рисует эту строку сам.
- Вызов внешнего устройства больше не выглядит как запись файла: в строке видно само устройство и его операцию, а такие вызовы больше не попадают в учёт изменений файлов.
- В спокойном виде после ответа остаётся строка с хешами созданных коммитов, если показ Git включён. Созданные коммиты — единственное, что этот вид больше не прячет: без такой строки лог утверждал бы, что ничего не произошло, там где история изменилась. Сами Git-действия во время работы по-прежнему скрыты, изменения файлов тоже, а если показ Git выключить — строки не будет.

### Проверено

- Плагин рассчитан на актуальный OMP: закреплённый host — **18.0.1**, поддержка более старых версий прекращена, минимальная поддерживаемая версия — **18.0.1**.
- Плагин переведён на новый OMP 18.0.1. В этой версии OMP переписал внутреннее устройство журнала: строки уходят в неизменяемую историю пачками, а у каждого блока появилось явное состояние. Плагин, собранный под 18.0.0, на 18.0.1 просто не узнаёт журнал и молча отдаёт весь вывод штатному интерфейсу — поэтому вместе с обновлением поднята и минимальная версия. После перевода компактный вид, тихий вид, восстановление истории и сообщения о фоновых заданиях снова работают на живом OMP 18.0.1.

---

## 1.1.3 — 22 августа 2026

### Исправлено

- Карточки запуска процессов в hub (🚀 Launch — старт и логи supervised-процессов) теперь тоже сворачиваются в короткую строку вместо большой «родной» рамки.
- Действия, запущенные тем же сообщением рядом с такими карточками, больше не остаются большими.
- Bash-команды, которые OMP показывает в рамке, тоже сворачиваются в короткую строку, а не висят большой карточкой всё время выполнения скрипта.
- Когда запущенный процесс завершается, это показывается своей спокойной строкой.

---

## 1.1.2 — 21 августа 2026

### Исправлено

- После продолжения сессии (`omp -c` / resume) история с чтением внутренних ссылок вроде `skill://` и `agent://` снова остаётся короткими строками, а не пустыми или огромными «родными» карточками.
- Когда агент запускает несколько bash-команд почти одновременно, они тоже сворачиваются в короткие строки, а не остаются большими карточками на весь ход.

### Проверено

- Закреплённый development/release-gate host — штатный OMP **17.4.0**; публичный порог `engines.omp` по-прежнему **>=17.2.12**.

---

## 1.1.1 — 20 августа 2026

### Исправлено

- Инструменты write/edit показываются короткой строкой, не дожидаясь, пока модель закончит работу над файлом: правки и записи сворачиваются уже пока аргументы ещё идут потоком, а не только после завершения. Большая карточка write/edit больше не висит на экране до конца вызова.

---

## 1.1.0 — 19 августа 2026

### Исправлено

- Восстановлено компактное отображение после зафиксированной навигации по `/tree` и `/branch` (восстановление session_tree / session_branch).
- LLM-компакция и пересборка свёрнутого транскрипта сохраняют историю компактной, а не разворачивают её в нативный вид.
- Когда `/shake` стирает вывод инструментов из контекста и заново перерисовывает карточки чтения файлов, эти куски больше не остаются в нативном виде, а заново оборачиваются плагином в компактный.
- Более безопасный счётчик изменённых строк. Раньше, чтобы вывести счётчик, плагину надо было прочитать файл до того, как модель начнёт его переписывать, — это было опасно. Теперь это не требуется, а для приватности плагин не считывает количество строк у файлов вне рабочего каталога.
- Дополнительная защита конфига плагина от конфликтов перезаписи: если сохранение настроек сбилось, экран и файл не остаются «наполовину старыми, наполовину новыми», а повторные сохранения подряд не мешают друг другу.
- Повреждённый файл настроек при сохранении больше не затирается молча значениями по умолчанию.
- Меню `/compact-settings` удобнее: выбранный пункт не «прыгает», в поле числа нельзя случайно вставить ерунду.
- Если плагин один раз понял, что с этой версией OMP ему не состыковаться, простой выключатель в настройках не заставляет его снова и снова пытаться «вклиниться»: до новой сессии остаётся обычный вид OMP.
- Идентичность сообщения в RunStats (responseId / provider / model / digest) — строка статистики внизу хода реже врёт, когда ответы ассистента похожи друг на друга.
- Крутилка «ещё думаем» не крутится впустую, когда ждать уже нечего.
- Смена сессии, неполный старт и запоздалые «действие всё-таки закончилось» переносятся спокойнее.
- Реестры инструментов с null-прототипом; подгонка ширины строки мутаций; однократное предупреждение при сбоях аудита и декоративных элементов.

### Расширена функциональность, чтобы идти в ногу с OMP

- Компактные однострочники: вставка правил, напоминание о todo, пользовательские `!bash`/`$python`, skill, поздняя диагностика — всё это теперь приводится к компактному виду.
- Закреплённый development/release-gate host: штатный OMP **17.3.8** (публичный порог `engines.omp >=17.2.12` не меняется).

### Небольшие изменения

- Русский README — основной в репозитории; английский лежит в `README.en.md`.
- Включён `noUncheckedIndexedAccess`; выделены небольшие общие хелперы.
- В ARCHITECTURE описано измеренное удержание памяти `#states`.
- Релизы переписаны на двух языках.
- Если экран OMP окажется совсем незнакомым, плагин сам отступит к обычному виду OMP.

### Проверено

- Гейт на штатном OMP 17.3.8: **1175** тестов, **0** падений, **6546** проверок в **28** файлах.
- TypeScript + линт и формат Biome + синхронизация метаданных Marketplace.

---

## 1.0.4 — 17 августа 2026

### Исправлено

- Поведение auto-shake стало безопаснее для сессий с большим количеством фоновых процессов и скриптов: он не срабатывает, пока ход ещё закрывается.
- Подсчёт изменений в файлах не подвешивает экран на странных или слишком длинных путях.
- Очень длинные подписи к действиям обрезаются аккуратнее, без поломки редких букв.

### Изменено

- Когда агент удаляет файл, это отдельная красная строка, а не «правка, где ничего не добавили». Если количество убранных строк можно посчитать честно — цифра красная и точная.
- Удаление файла без возможности отследить количество изменённых строк теперь сохраняется в логе строкой `delete` без статистики, а не скрывается полностью: неизвестное число не придумывается, но видно, какой файл убрали.
- Инструменты стали определяться по общему шаблону — это расширяет поддержку версий.

---

## 1.0.3 — 14 августа 2026

### Исправлено

- Автоматический shake выполняется только после успешного завершения сбора аудит-свидетельств. При неудавшемся или прерванном сборе (таймаут барьера, переключение или завершение сессии) shake пропускается, а не удаляет результаты инструментов, ещё не доставленные модели.
- Если задача завершилась неудачей или была прервана, её строки больше не висят вечно: при следующем успешном завершении новой задачи они приводятся к компактному виду.
- Отголоски прошлого хода больше не портят следующий: короткий вид не срывается в огромные карточки без причины.
- Исправлена ошибка, из-за которой фоновые bash-скрипты и подобные инструменты могли заставить плагин считать, что началась новая задача. Поздние результаты, приходящие после того как статистика посчитана и задача считается завершённой, больше не воспринимаются как начало новой задачи и не ломают статистику.
- Диалог настроек держит сфокусированную строку видимой на низких терминалах: он читает живую высоту терминала из host TUI, передаваемого в `ui.custom`, и рисует окно настроек корректно.
- Исправлена ошибка, при которой последовательное сохранение из двух разных сессий на одной машине ломало конфиг плагина.
- Если файл настроек плагина не сохранился, связанные переключатели в OMP возвращаются как было: меню и реальность не расходятся.
- Повреждённые настройки при сохранении не перезаписываются молча значениями по умолчанию.
- Улучшения и правки кода, определения Git-команд и вызовов инструментов: строки про Git выглядят чище — без лишней иконки ошибки, короткие служебные флаги Git тоже узнаются, у коммита без темы по-прежнему виден хэш.

### Изменено

- Лишние поля в файле настроек, которых эта версия ещё не знает, при сохранении не выбрасываются — чтобы не потерять то, что вы или новая версия туда положили.

---

## 1.0.2 — 13 августа 2026

### Исправлено

- Исправлена ошибка, из-за которой в длинных сессиях после компакта плагин мог терять отслеживание одного логического хода, не выводить статистику и переключать вывод инструментов на нативный вид.

### Добавлено

- Инструменты `browser`, `computer`, `resolve` и `reject` выводятся компактными однострочными строками, а `ask` сохраняет нативную интерактивную поверхность.
- Закреплённый development/release host обновлён до штатного OMP 17.3.1 при сохранении публичной совместимости с OMP `>=17.2.12`.

---

## 1.0.1 — 12 августа 2026

Полировка публичного релиза. Этот патч-релиз не меняет поведение плагина, но подтягивает публичный репозиторий, метаданные релиза, документацию и приватность.

### Изменено

- В оба README добавлены GIF-демонстрации «до/после» со ссылками на исходные MP4-записи.
- Нормализованы все 11 пар replay-фикстур и эталонов: убраны сырые следы происхождения сессий, машинные пути, таймстемпы, внутренние пространства имён, метки воркеров и длинные ID вызовов инструментов.
- Перегенерация replay теперь требует внешний неотслеживаемый `OMP_REPLAY_MANIFEST`.
- Исправлены границы в описании архитектуры, примеры расширения, инструкции по обновлению и указания по проверке для контрибьюторов.
- Включён `noUnusedLocals`, усилены контракты на раскладку репозитория и метаданные релиза.

### Проверено

- 774 теста, 0 падений, 3 928 проверок в 28 файлах.
- Строгие проверки TypeScript и Biome.
- Проверка ссылок в README и документации.
- Проверки содержимого пакета и dry-run для Marketplace.

---

## 1.0.0 — 12 августа 2026

Первый публичный выпуск.

### Зачем плагин

OMP по ходу задачи показывает много больших карточек: чтения, поиски, команды, правки. Через несколько шагов в этом трудно найти главное. omp-compact меняет только отображение: выполнение инструментов остаётся нативным, а активность инструментов в терминале становится легче просматривать.

### Главное

- Три режима отображения:
  - **live** (по умолчанию) — после удачного ответа убирает шум и оставляет суть: правки файлов, сводку коммитов и по желанию статистику;
  - **compact** — весь короткий след остаётся на экране;
  - **clear** — почти только ответ, максимально тихо.
- Политика сохранения важного на виду: строки об изменениях файлов и Git остаются в логе навсегда — если только не включён режим `clear`.
- Статистика в терминале показывает траты времени и токенов по каждой задаче отдельно.
- Опциональная чистка контекста авто-shake: после превышения контекстом порога в N токенов или после каждой задачи.
- Плагин не меняет, *что* агенту разрешено делать — только *как* это выглядит.
- Есть меню `/compact-settings`.
- Восстановление в той же сессии после `/tree` и `/shake`, без перезапуска OMP.
- Fail-open к нативному виду для незнакомых, интерактивных, развёрнутых и несовместимых TUI-поверхностей: сессия из-за плагина не должна падать.

### Совместимость

- OMP **17.2.12 и новее**.
- Первый релиз проверяли на OMP 17.2.12.

### По умолчанию

- Порог для опционального авто-`/shake`: **120 000** (единиц размера контекста в настройках). **0** — после каждого подходящего хода.

---

## Ссылки на сравнение версий

- [Не выпущено ← 1.1.3](https://github.com/arksdev/omp-compact/compare/v1.1.3...HEAD)
- [1.1.3 ← 1.1.2](https://github.com/arksdev/omp-compact/compare/v1.1.2...v1.1.3)
- [1.1.2 ← 1.1.1](https://github.com/arksdev/omp-compact/compare/v1.1.1...v1.1.2)
- [1.1.1 ← 1.1.0](https://github.com/arksdev/omp-compact/compare/v1.1.0...v1.1.1)
- [1.1.0 ← 1.0.4](https://github.com/arksdev/omp-compact/compare/v1.0.4...v1.1.0)
- [1.0.4 ← 1.0.3](https://github.com/arksdev/omp-compact/compare/v1.0.3...v1.0.4)
- [1.0.3 ← 1.0.2](https://github.com/arksdev/omp-compact/compare/v1.0.2...v1.0.3)
- [1.0.2 ← 1.0.1](https://github.com/arksdev/omp-compact/compare/v1.0.1...v1.0.2)
- [1.0.1 ← 1.0.0](https://github.com/arksdev/omp-compact/compare/v1.0.0...v1.0.1)
- [1.0.0](https://github.com/arksdev/omp-compact/releases/tag/v1.0.0)

---

# omp-compact changelog

In plain words — what changed for a person working in OMP with this plugin.

---

## Unreleased

### Fixed

- Arrow keys work in the settings dialog again, including in terminals that send them differently from most: previously the cursor in such terminals moved only with `j` and `k`. Thanks to [**@materemias**](https://github.com/materemias)
- Arrow combinations with a held modifier (Shift, Alt, Ctrl) no longer move the cursor or toggle values.
- After the context was shaken automatically, completed reads stopped hiding and expanded back into full cards. A finished turn now looks the same after a shake as it did before it.
- Returning to a saved session shows its history compact again. Restored reads previously expanded into full cards whenever the agent thought or answered between two reads of the same turn — which is almost always.
- Notices about finished background processes and jobs no longer tear the compact log apart with blank lines above and below: such a row now sits flush against its neighbours and leaves together with the rest of the routine once the step is done.
- Resuming a session no longer shows the routine of turns that already ended with an answer. Restored history used to expand into a complete log even when the chosen view removes such routine: reads, searches and commands from long-answered turns stayed on screen. Restored history now looks the way it does right after an answer in the chosen view, and the complete log stays for those who picked it.
- The quiet view no longer leaves the routine of an interrupted or failed turn on screen: its reads, searches and commands now go the same way they go after an ordinary answer. Interrupting the agent, or hitting an error, used to keep the turn's complete log on screen even though the chosen view is precisely the one without routine. Reading unfinished work back is still comfortable in the other two views, and the line with hashes for created commits stays even for an interrupted turn.
- Background-job completion notices are gone from restored history in the quiet view as well. Such a row used to be the only thing left in the middle of a removed history, because there was no telling which turn owned it; it now follows the chosen view like everything else.

### Added

- A new `alt+c` shortcut cycles the display: compact, live, clear, plugin off, and back to compact. No need to open the settings dialog, and each press prints one line naming what will apply. A switch takes effect from the start of the agent's next piece of work, and turning the plugin off keeps the last chosen view. The chord itself can be changed in settings to any free combination; the new one starts working after restarting OMP.

### Changed

- `/vibe` mode is more compact: instead of already-killed or idle subagents, only active ones are shown. Each session takes one or two short rows — state, name, how many turns are done, how long the current one is running, which model, and what the session is doing right now.
- The compact view of parallel worker sessions in `/vibe` mode became a separate toggle. It is on by default; turning it off brings those sessions back as stock OMP cards.
- The process-completion message is now shown by OMP itself — the plugin no longer draws that row.
- A call to an external device no longer looks like a file write: the row names the device itself and the operation it performs, and such calls are no longer counted as file changes.
- The quiet view now keeps the line with hashes for created commits after the answer, when showing Git is enabled. Created commits are the one thing this view no longer hides: without that line the log would claim nothing happened where history changed. Git actions during the work stay hidden, so do file changes, and disabling Git removes the line as well.

### Verified

- The plugin targets current OMP: pinned host is **18.0.1**, support for older versions is dropped, and the minimum supported version is **18.0.1**.
- The plugin moved to the new OMP 18.0.1. That release rewrote the transcript internals: rows retire into immutable history in batches, and every block now carries an explicit state. A build made for 18.0.0 simply does not recognize the transcript on 18.0.1 and silently hands the whole output to the native interface — which is why the minimum version moves with the pin. After the move, the compact view, the quiet view, restored history and background-job notices all work again on live OMP 18.0.1.

---

## 1.1.3 — 22 August 2026

### Fixed

- Process-launch cards in hub (🚀 Launch — start and logs of supervised processes) now collapse to a short row instead of a large native frame.
- Actions started by the same message next to such cards no longer stay large.
- Bash commands that OMP shows in a frame also collapse to a short row instead of hanging as a large card for the whole script run.
- When a launched process finishes, that is shown by its own quiet row.

---

## 1.1.2 — 21 August 2026

### Fixed

- After resuming a session (`omp -c` / resume), history with reads of internal links such as `skill://` and `agent://` stays as short rows again instead of empty or huge native cards.
- When the agent starts several bash commands almost at once, they collapse to short rows too instead of staying large cards for the whole turn.

### Verified

- Pinned development/release-gate host is stock OMP **17.4.0**; the public `engines.omp` floor remains **>=17.2.12**.

---

## 1.1.1 — 20 August 2026

### Fixed

- write/edit tools show as a short row without waiting for the model to finish working on the file: edits and writes collapse while arguments are still streaming, not only after completion. The large write/edit card no longer stays on screen until the call ends.

---

## 1.1.0 — 19 August 2026

### Fixed

- Restored compact presentation after committed `/tree` and `/branch` navigation (session_tree / session_branch restore).
- LLM compaction and collapsed-transcript rebuild keep history compact instead of expanding it back to the native view.
- When `/shake` clears tool output from the context and redraws file-read cards, those fragments no longer stay native — the plugin wraps them back into the compact view.
- Safer changed-line counter. Previously the plugin had to read the file before the model started rewriting it, which was risky. That is no longer required, and for privacy the plugin does not count lines of files outside the working directory.
- Extra protection of the plugin config against overwrite conflicts: if a settings save fails, the screen and the file are not left half-old and half-new, and repeated saves in a row no longer interfere with each other.
- A malformed settings file is no longer silently overwritten with defaults on save.
- The `/compact-settings` menu is easier to use: the selected row does not jump, and nonsense cannot be pasted into a number field.
- Once the plugin has determined that it cannot attach to this OMP version, a simple toggle in settings no longer makes it retry over and over: the plain OMP view stays until a new session.
- Message identity in RunStats (responseId / provider / model / digest) — the statistics row at the end of a turn lies less often when assistant replies resemble each other.
- The "still thinking" spinner does not spin for nothing when there is nothing left to wait for.
- Session switches, incomplete startup, and late "the action did finish after all" events are handled more calmly.
- Null-prototype tool registries; mutation row width fit; warn-once on audit and decorative failures.

### Extended to keep up with OMP

- Compact one-liners: rule injects, todo reminders, user `!bash`/`$python`, skill, late diagnostics — all of these are now brought to the compact form.
- Pinned development/release-gate host: stock OMP **17.3.8** (the public `engines.omp >=17.2.12` floor is unchanged).

### Minor changes

- The Russian README is the repository default; the English one lives at `README.en.md`.
- `noUncheckedIndexedAccess` enabled; small shared helpers extracted.
- ARCHITECTURE documents the measured `#states` memory retention.
- Release notes rewritten in two languages.
- If the OMP screen turns out to be completely unfamiliar, the plugin falls back to the plain OMP view on its own.

### Verified

- Stock OMP 17.3.8 gate: **1175** tests, **0** failures, **6546** assertions across **28** files.
- TypeScript + Biome lint and format + Marketplace metadata sync.

---

## 1.0.4 — 17 August 2026

### Fixed

- auto-shake behavior is safer for sessions with many background processes and scripts: it does not fire while a turn is still closing.
- Counting file changes no longer stalls the screen on unusual or overly long paths.
- Very long action labels are truncated more carefully, without breaking rare characters.

### Changed

- When the agent deletes a file, it is a separate red row rather than "an edit that added nothing". When the number of removed lines can be counted honestly, the figure is red and exact.
- A file deletion whose changed-line count cannot be determined is now kept in the log as a `delete` row without stats instead of being hidden entirely: an unknown number is never invented, but it stays visible which file was removed.
- Tools are recognized by a common pattern, which widens version support.

---

## 1.0.3 — 14 August 2026

### Fixed

- Automatic shake runs only after the audit-evidence collection completes successfully. On a failed or interrupted collection (barrier timeout, session switch, or shutdown) the shake is skipped instead of removing tool results that have not reached the model yet.
- If a task failed or was interrupted, its rows no longer hang forever: they are brought to the compact view when the next task finishes successfully.
- Echoes of a previous turn no longer spoil the next one: the compact view does not break into huge cards without reason.
- Fixed an issue where background bash scripts and similar tools could make the plugin think a new task had started. Late results that arrive after statistics are computed and the task is considered finished no longer count as the start of a new task and no longer break statistics.
- The settings dialog keeps the focused row visible on short terminals: it reads the live terminal height from the host TUI passed to `ui.custom` and renders the settings window correctly.
- Fixed an issue where sequential saves from two different sessions on one machine broke the plugin config.
- If the plugin settings file failed to save, the related OMP toggles are restored as they were: the menu and reality do not diverge.
- Malformed settings are not silently overwritten with defaults on save.
- Improvements and fixes in the code, in Git command recognition, and in tool call recognition: Git rows look cleaner — no duplicate error icon, short Git service flags are recognized too, and a commit without a subject still shows its hash.

### Changed

- Extra fields in the settings file that this version does not know yet are not dropped on save — so nothing you or a newer version put there gets lost.

---

## 1.0.2 — 13 August 2026

### Fixed

- Fixed an issue where, in long sessions after compaction, the plugin could lose track of a logical run, stop reporting statistics, and switch tool output back to the native view.

### Added

- The `browser`, `computer`, `resolve`, and `reject` tools render as compact one-line rows, while `ask` keeps the native interactive surface.
- Pinned development/release host updated to stock OMP 17.3.1, keeping public compatibility with OMP `>=17.2.12`.

---

## 1.0.1 — 12 August 2026

Public release polish. This patch release does not change plugin behavior; it tightens the public repository, release metadata, documentation, and privacy.

### Changed

- Added before/after GIF demonstrations to both READMEs, with links to the original MP4 recordings.
- Normalized all 11 replay fixture/golden pairs: removed raw session provenance, machine paths, timestamps, internal namespaces, worker labels, and long tool-call IDs.
- Replay regeneration now requires an external untracked `OMP_REPLAY_MANIFEST`.
- Corrected architecture bounds, extension examples, upgrade instructions, and contributor verification guidance.
- Enabled `noUnusedLocals` and strengthened repository-layout and release-metadata contracts.

### Verified

- 774 tests, 0 failures, 3,928 assertions across 28 files.
- Strict TypeScript and Biome checks.
- README and documentation link checks.
- Package payload and Marketplace dry-run checks.

---

## 1.0.0 — 12 August 2026

Initial public release.

### Why this plugin

During a task OMP shows many large cards: reads, searches, commands, edits. After a few steps it is hard to find what matters. omp-compact changes presentation only: tool execution stays native, while tool activity in the terminal becomes easier to scan.

### Highlights

- Three presentation modes:
  - **live** (default) — after a successful reply it removes the noise and keeps the essentials: file edits, a commit summary, and optionally statistics;
  - **compact** — the whole short trail stays on screen;
  - **clear** — almost nothing but the reply, as quiet as possible.
- Important things stay visible: rows about file changes and Git remain in the log permanently — unless `clear` mode is on.
- Terminal statistics show time and token spend per task separately.
- Optional context cleanup via auto-shake: after the context passes a threshold of N tokens, or after every task.
- The plugin does not change *what* the agent is allowed to do — only *how* it looks.
- There is a `/compact-settings` menu.
- Same-session restoration after `/tree` and `/shake`, without restarting OMP.
- Fail-open to the native view for unknown, interactive, expanded, and incompatible TUI surfaces: the session must not crash because of the plugin.

### Compatibility

- OMP **17.2.12 and later**.
- The first release was verified on OMP 17.2.12.

### Defaults

- Threshold for the optional auto-`/shake`: **120,000** (context-size units in settings). **0** — after every eligible turn.

---

## Version comparison links

- [Unreleased ← 1.1.3](https://github.com/arksdev/omp-compact/compare/v1.1.3...HEAD)
- [1.1.3 ← 1.1.2](https://github.com/arksdev/omp-compact/compare/v1.1.2...v1.1.3)
- [1.1.2 ← 1.1.1](https://github.com/arksdev/omp-compact/compare/v1.1.1...v1.1.2)
- [1.1.1 ← 1.1.0](https://github.com/arksdev/omp-compact/compare/v1.1.0...v1.1.1)
- [1.1.0 ← 1.0.4](https://github.com/arksdev/omp-compact/compare/v1.0.4...v1.1.0)
- [1.0.4 ← 1.0.3](https://github.com/arksdev/omp-compact/compare/v1.0.3...v1.0.4)
- [1.0.3 ← 1.0.2](https://github.com/arksdev/omp-compact/compare/v1.0.2...v1.0.3)
- [1.0.2 ← 1.0.1](https://github.com/arksdev/omp-compact/compare/v1.0.1...v1.0.2)
- [1.0.1 ← 1.0.0](https://github.com/arksdev/omp-compact/compare/v1.0.0...v1.0.1)
- [1.0.0](https://github.com/arksdev/omp-compact/releases/tag/v1.0.0)
