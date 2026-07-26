# Website hero recording — higher FPS for smooth playback.
# Run from supply-chain-auditor repo root after docs/demo/setup.sh:
#   vhs docs/demo/hero-site.tape
# Then copy the mp4 into pkgxray-site/assets/hero.mp4
Output docs/demo/hero-site.mp4

Require pkgxray

Set Shell bash
# Capture at 8fps (vhs-correct timing), then we upsample in ffmpeg for
# smooth site playback. Higher Set Framerate values compress wall-clock.
Set Framerate 8
Set FontSize 22
Set Width 1280
Set Height 900
Set Padding 20
Set Theme {"name":"stik-latte","background":"#1c1510","foreground":"#e2c595","cursor":"#faeed0","selection":"#4a3826","black":"#332818","red":"#c76b3f","green":"#f2dcb1","yellow":"#e2c595","blue":"#b0875a","magenta":"#c8a376","cyan":"#bfa67e","white":"#faeed0","brightBlack":"#8a6b4a","brightRed":"#d98a5f","brightGreen":"#faeed0","brightYellow":"#f2dcb1","brightBlue":"#c8a376","brightMagenta":"#e2c595","brightCyan":"#f2dcb1","brightWhite":"#fff8e7"}
Set WindowBar Colorful
Set BorderRadius 8
Set TypingSpeed 45ms

Hide
Type `PS1='\[\e[1;38;2;176;135;90m\]$\[\e[0m\] ' && cd /tmp/pkgxray-demo && clear`
Enter
Show

Sleep 600ms
Type "pkgxray guard npm:express@4.21.0"
Sleep 400ms
Enter
Wait@60s /\$/
Sleep 5s

Hide
Type "clear"
Enter
Show

Sleep 400ms
Type "pkgxray guard ./sample-malicious-pkg"
Sleep 400ms
Enter
Wait@60s /\$/
Sleep 7s
