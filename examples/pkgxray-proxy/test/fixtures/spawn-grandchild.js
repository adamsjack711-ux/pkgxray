#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
if (process.env.PKGXRAY_GRANDCHILD_PID_FILE) {
  writeFileSync(process.env.PKGXRAY_GRANDCHILD_PID_FILE, String(child.pid));
}
setInterval(() => {}, 1000);
