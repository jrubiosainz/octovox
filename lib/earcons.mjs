import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// The same sounds the GitHub Copilot app plays for its own dictation (read from the installed app).
const SOUNDS_DIR = "/Applications/GitHub Copilot.app/Contents/Resources/sounds";
// Length of voice-open.wav plus a margin: trimmed from the start of the recording.
export const OPEN_EARCON_TRIM_MS = 220;

export function earconAvailable(name) {
    return existsSync(`${SOUNDS_DIR}/voice-${name}.wav`);
}

export function playEarcon(name) {
    const file = `${SOUNDS_DIR}/voice-${name}.wav`;
    if (!existsSync(file)) return false;
    const proc = spawn("/usr/bin/afplay", ["-v", "0.7", file], { stdio: "ignore" });
    proc.on("error", () => {});
    return true;
}
