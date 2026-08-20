# Bring your own browser

Attach pagefetch to a Chrome or Brave you are already running, instead of
letting it launch its own. Fetches then happen in that browser, on that machine,
with that profile and that IP.

```bash
./.local/brave.sh                 # Brave with --remote-debugging-port=9222
source .local/env.sh              # sets PAGEFETCH_CDP_URL
npm run start:local               # needs Node >= 22.5 for node:sqlite
```

Node 20 cannot run this (`node:sqlite` landed in 22.5). If your system Node is
older, run the container with host networking instead — it ships Node 24 and
`--network host` lets it reach the browser on loopback:

```bash
docker run -d --name pagefetch-byob --network host --user "$(id -u):$(id -g)" \
  -e PAGEFETCH_TOKEN="$PAGEFETCH_TOKEN" \
  -e PAGEFETCH_CDP_URL=http://127.0.0.1:9222 \
  -e PAGEFETCH_PROFILE_DIR=/data/profile -e PAGEFETCH_CACHE_PATH=/data/pagefetch.db \
  -v "$PWD/.local:/data" pagefetch:local
```

## Why this is not disguise

It genuinely is a real browser. No fingerprint patch, no stealth plugin, no
user-agent string games, no CAPTCHA service. A challenge that passes here passes
because the client really is what it claims to be — which is the opposite of
defeating it.

That distinction is the whole reason this mode exists rather than the
alternatives, and it is worth keeping in mind before adding anything to it.

## What it costs

**The validating egress proxy is not in the path.** We cannot pass
`--proxy-server` to a browser we did not launch, so URL validation moves onto the
page instead. That catches the submitted URL and every subresource, but **not a
same-document redirect hop** — Chromium follows those internally and never
re-enters routing. The startup log says so every time.

If you want the full guarantee back, launch the browser through the proxy
yourself and keep both:

```bash
brave-browser --remote-debugging-port=9222 \
  --user-data-dir=~/.pagefetch-brave \
  --proxy-server=http://127.0.0.1:<pagefetch proxy port> \
  --proxy-bypass-list='<-loopback>'
```

**Per-domain cookie jars are given up.** Attached mode uses the browser's own
context, because a `newContext()` would be a blank incognito profile with none of
the cookies or history that are the reason for connecting. One browser, one jar,
and it is yours.

**Memory management is off.** We do not restart, resize or close a browser we did
not launch.

## Use a separate profile

`.local/brave.sh` defaults to `~/.pagefetch-brave` rather than your everyday
profile. Attaching to your main profile hands the service reach into every
session you are logged into, and anything it fetches carries those cookies.
Start separate; point it at your real profile only if you decide the extra
realism is worth that, and know what you are trading.
