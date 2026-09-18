/**
 * Structural typing for the host theme.
 *
 * OMP 18.0.1 through 18.2.0 exported Theme from `@oh-my-pi/pi-coding-agent/modes/theme/theme`.
 * OMP 18.2.5 moved the theme engine into `@oh-my-pi/pi-tui/theme/theme`.
 * Decoupling via this structural interface protects against host relocations
 * while remaining fully compatible across all supported OMP versions.
 */

export type ThemeColor = string;

export interface Theme {
	readonly boxRound?: {
		topLeft: string;
		topRight?: string;
		bottomLeft: string;
		bottomRight?: string;
		horizontal: string;
		vertical?: string;
	};
	readonly spinnerFrames?: readonly string[];
	readonly icon?: Record<string, string>;
	readonly format?: {
		bullet?: string;
		dash?: string;
		bracketLeft?: string;
		bracketRight?: string;
	};
	fg(color: ThemeColor, text: string): string;
	bg(color: ThemeColor, text: string): string;
	bold(text: string): string;
	underline?(text: string): string;
	italic?(text: string): string;
	strikethrough?(text: string): string;
	inverse?(text: string): string;
	getFgAnsi?(color: ThemeColor): string;
	getBgAnsi?(color: ThemeColor): string;
	getSpinnerFrames?(name?: string): readonly string[];
	symbol?(name: string): string;
	styledSymbol?(name: string, role?: string): string;
}
