# Hero GIF for the README. Run docs/demo/setup.sh first, then from the repo
# root: vhs docs/demo/hero.tape
Output docs/demo/hero.gif

Require pkgxray

Set Shell bash
# Framerate 8 is load-bearing: at this window size vhs can't capture faster
# than ~10 fps, and when it falls behind the output plays several times too
# fast (a 17 s session came out as 3 s at the default framerate).
Set Framerate 8
Set FontSize 16
Set Width 1640
Set Height 1060
Set Padding 24
# Warm earth-tone theme built from the stik-cli "latte" palette
# (coffee / mocha / tan / wheat / cream, rust for alarms).
Set Theme {"name":"stik-latte","background":"#1c1510","foreground":"#e2c595","cursor":"#faeed0","selection":"#4a3826","black":"#332818","red":"#c76b3f","green":"#f2dcb1","yellow":"#e2c595","blue":"#b0875a","magenta":"#c8a376","cyan":"#bfa67e","white":"#faeed0","brightBlack":"#8a6b4a","brightRed":"#d98a5f","brightGreen":"#faeed0","brightYellow":"#f2dcb1","brightBlue":"#c8a376","brightMagenta":"#e2c595","brightCyan":"#f2dcb1","brightWhite":"#fff8e7"}
Set WindowBar Colorful
Set BorderRadius 8
Set TypingSpeed 40ms

Hide
# Caramel "$ " prompt (vhs's default prompt is a hardcoded indigo that
# bypasses the theme). The Wait calls below match this prompt via /\$/.
Type `PS1='\[\e[1;38;2;176;135;90m\]$\[\e[0m\] ' && cd /tmp/pkgxray-demo && clear`
Enter
Show

Sleep 800ms
Type "pkgxray guard npm:express@4.21.0"
Sleep 600ms
Enter
Wait@60s /\$/
Sleep 3.5s

Hide
Type "clear"
Enter
Show

Sleep 300ms
Type "pkgxray guard ./sample-malicious-pkg"
Sleep 600ms
Enter
Wait@60s /\$/
Sleep 6s
