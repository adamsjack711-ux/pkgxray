"use strict";

// Tokenize command words without executing substitutions. Quoted examples in
// echo/printf are inert; only a curl command with a file-upload argument counts.
function shellUploadHints(source) {
  const commands = []; let words = [], word = '', start = 0, quote = null;
  const push = () => { if (word) words.push({ value: word, start }); word = ''; };
  const finish = () => { push(); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < Math.min(source.length, 1024 * 1024); i++) {
    const c = source[i];
    if (!word && !quote) start = i;
    if (c === '\\' && quote !== "'") { word += source[++i] || ''; continue; }
    if (quote) { if (c === quote) quote = null; else word += c; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#' && !word) { while (i < source.length && source[i] !== '\n') i++; finish(); continue; }
    if ('\n;|&'.includes(c)) { finish(); continue; }
    if (/\s/.test(c)) { push(); continue; }
    word += c;
  }
  finish();
  const hints = [];
  for (const command of commands) {
    const first = command.findIndex(w => !/^[A-Za-z_][\w]*=/.test(w.value));
    if (first < 0 || !/^(?:\S*\/)?curl$/.test(command[first].value)) continue;
    for (let i = first + 1; i < command.length; i++) {
      const flag = command[i].value;
      const match = flag.match(/^(--(?:data|data-binary|data-raw|upload-file)|-[dT])(?:=(.*))?$/);
      if (!match) continue;
      const arg = match[2] ?? command[++i]?.value;
      if (!arg) continue;
      const upload = /upload-file|-T/.test(match[1]) ? arg : arg.startsWith('@') ? arg.slice(1) : '';
      // --data-raw deliberately does not interpret @ as a filename.
      if (match[1] === '--data-raw') continue;
      if (/(?:^|\/)\.ssh\/id_(?:rsa|dsa|ecdsa|ed25519)$|(?:^|\/)\.aws\/credentials$|(?:^|\/)\.npmrc$/.test(upload)) {
        hints.push({ index: command[first].start, kind: 'credential-file-upload' }); break;
      }
    }
  }
  return hints.slice(0, 8);
}
module.exports = { shellUploadHints };
