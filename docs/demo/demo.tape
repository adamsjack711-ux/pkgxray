# "How it works" MP4. Run docs/demo/setup.sh first, then from the repo root:
# vhs docs/demo/demo.tape
Output docs/demo/pkgxray-demo.mp4

Require pkgxray

Set Shell bash
# Framerate 8 is load-bearing — see hero.tape.
Set Framerate 8
Set FontSize 16
Set Width 1640
Set Height 1060
Set Padding 24
# Warm earth-tone theme built from the stik-cli "latte" palette — see hero.tape.
Set Theme {"name":"stik-latte","background":"#1c1510","foreground":"#e2c595","cursor":"#faeed0","selection":"#4a3826","black":"#332818","red":"#c76b3f","green":"#f2dcb1","yellow":"#e2c595","blue":"#b0875a","magenta":"#c8a376","cyan":"#bfa67e","white":"#faeed0","brightBlack":"#8a6b4a","brightRed":"#d98a5f","brightGreen":"#faeed0","brightYellow":"#f2dcb1","brightBlue":"#c8a376","brightMagenta":"#e2c595","brightCyan":"#f2dcb1","brightWhite":"#fff8e7"}
Set WindowBar Colorful
Set BorderRadius 8
Set TypingSpeed 35ms

Hide
# Caramel "$ " prompt (vhs's default prompt is a hardcoded indigo that
# bypasses the theme). The Wait calls below match this prompt via /\$/.
Type `PS1='\[\e[1;38;2;176;135;90m\]$\[\e[0m\] ' && cd /tmp/pkgxray-demo && clear`
Enter
Show

Sleep 1s
Type "# pkgxray — SAFE / REVIEW / BLOCK verdicts on packages, BEFORE anything runs"
Enter
Sleep 2s

Type "# 1 · a healthy package clears, with the npm-vs-GitHub cross-check"
Enter
Sleep 1.2s
Type "pkgxray guard npm:express@4.21.0"
Sleep 600ms
Enter
Wait@60s /\$/
Sleep 5s

Hide
Type "clear"
Enter
Show

Type "# 2 · a trojaned package — modeled on the 2024 @solana/web3.js compromise"
Enter
Sleep 1.2s
Type "cat sample-malicious-pkg/index.js"
Sleep 400ms
Enter
Wait@10s /\$/
Sleep 3.5s
Type "pkgxray guard ./sample-malicious-pkg"
Sleep 600ms
Enter
Wait@60s /\$/
Sleep 6s
Type "echo exit code: $?"
Sleep 400ms
Enter
Wait@10s /\$/
Sleep 2.5s

Hide
Type "clear"
Enter
Show

Type "# 3 · audit a whole lockfile against OSV in one shot"
Enter
Sleep 1.2s
Type "pkgxray audit package-lock.json"
Sleep 600ms
Enter
Wait@60s /\$/
Sleep 5s

Type "# npm install -g pkgxray"
Enter
Sleep 3s
