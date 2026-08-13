# Changelog

All notable changes to `omp-compact` are documented in this file.
Все значимые изменения `omp-compact` документируются в этом файле.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow [Semantic Versioning](https://semver.org/).
Формат соответствует [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), а выпуски следуют [семантическому версионированию](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/arksdev/omp-compact/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/arksdev/omp-compact/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/arksdev/omp-compact/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/arksdev/omp-compact/releases/tag/v1.0.0
