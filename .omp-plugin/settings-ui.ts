// Entry point for the settings UI: every public name lives in a focused
// module (host-api, save-flow, cycle-handler, settings-dialog); this file
// only re-exports them.

// Re-exported for the store consumers that only need the patch type.
export type { CompactSettingsPatch, CompactSettingsStore } from "./config";
export type { DisplayCycleDeps } from "./cycle-handler";
export { cycleDisplayState } from "./cycle-handler";
export type {
	CommandApiLike,
	SettingsUiLike,
	ShortcutApiLike,
} from "./host-api";
export {
	chooseSettingsCommandName,
	registerDisplayCycleShortcut,
	registerSettingsCommand,
} from "./host-api";
export type { EnvMask, SaveFlowDeps, SaveOutcome } from "./save-flow";
export { notifySaveOutcome, saveSettingsFlow } from "./save-flow";
export type {
	SettingsDialogDeps,
	SettingsSessionDeps,
} from "./settings-dialog";
export {
	openSettingsDialog,
	runSettingsSession,
	SettingsDialog,
} from "./settings-dialog";
