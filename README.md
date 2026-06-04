# DestructoR666 Codec

Standalone local voice UI for OpenClaw Talk, styled like a radio/codec panel.

Run from the workspace root:

```bash
python3 -m http.server 8766
```

Then open this `localhost` URL so the browser can create the device identity OpenClaw requires:

```text
http://localhost:8766/apps/destructor-codec/
```

Use `DEMO` to inspect the interface without auth. For live mode, paste the local OpenClaw dashboard token into the Gateway token field, click `CONNECT`, then `CALL`.

The first live transport target is `gateway-relay`, so OpenAI realtime secrets stay behind the OpenClaw Gateway instead of being handled directly by this page.
