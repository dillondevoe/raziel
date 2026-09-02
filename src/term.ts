// Strips terminal-hostile bytes from model-or-log-derived text before it
// reaches stdout. This is the F2 fix from the 2026-09-01 adversarial review:
// raw ESC-initiated sequences (title-set, OSC-52 clipboard write, screen
// clear, SGR conceal, cursor moves, ...) must never reach a real terminal
// verbatim, whether live-streamed or replayed from a session log.
//
// Left alone: printable UTF-8 (including emoji), \n, \t. Everything else in
// C0 (0x00-0x1F, 0x7F) is stripped, and every ESC (0x1B) -initiated sequence
// is stripped in its entirety regardless of terminator (BEL, ST, or a lone
// escape with no terminator at all).

// OSC: ESC ] ... terminated by BEL (\x07) or ST (\x1b\\ or, some emitters, \x9c).
const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\|\x9c)/g;
// DCS/APC/PM/SOS: ESC P|X|^|_ ... terminated by ST (\x1b\\).
const DCS = /\x1b[PX^_][\s\S]*?\x1b\\/g;
// CSI: ESC [ then any number of parameter/intermediate bytes, then one final byte.
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// SS2/SS3: ESC N|O then one following byte.
const SS = /\x1b[NO]./g;
// Any remaining lone ESC (unrecognized/truncated sequence, or a bare ESC on its own).
const LONE_ESC = /\x1b/g;
// C0 control chars other than \n (0x0A) and \t (0x09), plus DEL (0x7F).
// eslint-disable-next-line no-control-regex
const C0_EXCEPT_NL_TAB = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Strips ANSI/OSC/DCS escape sequences and stray C0 control bytes from
 * text that is about to be written to a terminal. Printable UTF-8, \n and
 * \t pass through unchanged. */
export function sanitizeForTerminal(s: string): string {
  return s
    .replace(OSC, "")
    .replace(DCS, "")
    .replace(CSI, "")
    .replace(SS, "")
    .replace(LONE_ESC, "")
    .replace(C0_EXCEPT_NL_TAB, "");
}
