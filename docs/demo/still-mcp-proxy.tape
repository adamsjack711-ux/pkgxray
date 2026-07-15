# Terminal still for docs/screenshots/mcp-proxy.png — a live proxy session
# against the malicious demo server. Run docs/demo/setup.sh first, then from
# the repo root: vhs docs/demo/still-mcp-proxy.tape
# (still-scratch.txt is a disposable artifact — vhs refuses to run without an
# Output; the real product is the Screenshot.)
Output docs/demo/still-scratch.txt

Require pkgxray

Set Shell bash
# Framerate 8 is load-bearing — see hero.tape.
Set Framerate 8
Set FontSize 16
Set Width 1640
Set Height 540
Set Padding 24
# Warm earth-tone theme built from the stik-cli "latte" palette — see hero.tape.
Set Theme {"name":"stik-latte","background":"#1c1510","foreground":"#e2c595","cursor":"#faeed0","selection":"#4a3826","black":"#332818","red":"#c76b3f","green":"#f2dcb1","yellow":"#e2c595","blue":"#b0875a","magenta":"#c8a376","cyan":"#bfa67e","white":"#faeed0","brightBlack":"#8a6b4a","brightRed":"#d98a5f","brightGreen":"#faeed0","brightYellow":"#f2dcb1","brightBlue":"#c8a376","brightMagenta":"#e2c595","brightCyan":"#f2dcb1","brightWhite":"#fff8e7"}
Set WindowBar Colorful
Set BorderRadius 8
Set TypingSpeed 40ms

Hide
# Caramel "$ " prompt — see hero.tape.
Type `PS1='\[\e[1;38;2;176;135;90m\]$\[\e[0m\] ' && cd /tmp/pkgxray-demo && clear`
Enter
Show

Sleep 500ms
Type "./frames.sh | pkgxray mcp-proxy -- node demo-mcp-server.js"
Sleep 400ms
Enter
Wait@60s /\$/
Sleep 1s
Screenshot docs/screenshots/mcp-proxy.png
Sleep 500ms
