// Builds public/media/hold.wav: LEAD_MS of silence, then a source recording
// (default: CONVO-AGENT's typing.mp3). The silence is the ~1s gap between the
// acknowledgement ending and the hold sound starting (plan MEDIA-PLAYBACK.md).
// Decodes with macOS `afconvert` to 8 kHz mono 16-bit PCM (telephony rate).
// Run from server/: npx tsx scripts/make-hold-clip.mts [--src path/to/audio] [--lead-ms 1000]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const opt = (name: string, dflt: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
};
const SRC = opt('src', '/Users/dhartman/Development/01_Twilio/AgenticProcedure/ConversationAgent/conversation-agent/server/static/audio/typing.mp3');
const LEAD_MS = Number(opt('lead-ms', '1000'));
const RATE = 8000;

const tmp = mkdtempSync(join(tmpdir(), 'hold-'));
const decoded = join(tmp, 'decoded.wav');
execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEI16@${RATE}`, '-c', '1', SRC, decoded]);
const wav = readFileSync(decoded);
rmSync(tmp, { recursive: true });

// afconvert may add chunks (e.g. FLLR) before 'data': find it rather than assume offset 36.
let off = 12;
while (wav.toString('ascii', off, off + 4) !== 'data') off += 8 + wav.readUInt32LE(off + 4);
const pcm = wav.subarray(off + 8, off + 8 + wav.readUInt32LE(off + 4));

const data = Buffer.concat([Buffer.alloc(Math.round((LEAD_MS / 1000) * RATE) * 2), pcm]);
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16); // PCM chunk size
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28); // byte rate
header.writeUInt16LE(2, 32); // block align
header.writeUInt16LE(16, 34); // bits
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

const dir = fileURLToPath(new URL('../public/media/', import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}hold.wav`, Buffer.concat([header, data]));
console.log(`wrote ${dir}hold.wav: ${LEAD_MS}ms silence + ${(pcm.length / 2 / RATE).toFixed(2)}s of ${SRC}`);
