// Entry point for the settings UI: every public name now lives in a focused
// module (settings-keys, host-api, ansi-width, save-flow, cycle-handler,
// settings-dialog); this file only re-exports them so existing importers
// keep resolving the same names with the same types.

export { truncateAnsiSafe } from "./ansi-width";
// Re-exported for the store consumers that only need the patch type.
export type { CompactSettingsPatch, CompactSettingsStore } from "./config";
export type { DisplayCycleDeps } from "./cycle-handler";
export { cycleDisplayState } from "./cycle-handler";
export type {
	CommandApiLike,
	ComponentLike,
	KeybindingsLike,
	SettingsUiLike,
	ShortcutApiLike,
	ThemeLike,
} from "./host-api";
export {
	chooseSettingsCommandName,
	registerDisplayCycleShortcut,
	registerSettingsCommand,
} from "./host-api";
export type {
	EnvMask,
	HostBridgeApplyResult,
	HostBridgeLike,
	SaveFlowDeps,
	SaveOutcome,
} from "./save-flow";
export { saveSettingsFlow } from "./save-flow";
export type { SettingsDialogDeps } from "./settings-dialog";
export {
	humanizeThreshold,
	openSettingsDialog,
	SettingsDialog,
} from "./settings-dialog";
export type { ArrowDirection } from "./settings-keys";
export {
	KEY_BACKSPACE,
	KEY_CTRL_C,
	KEY_ENTER,
	KEY_ESCAPE,
	KEY_SPACE,
	normalizeArrowKey,
} from "./settings-keys";
