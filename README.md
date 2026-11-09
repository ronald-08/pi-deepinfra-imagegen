# pi-deepinfra-imagegen

A [pi](https://pi.dev) extension package that gives pi a native image tool backed by
[DeepInfra](https://deepinfra.com), so design work that needs raster output (comps,
decision comps, plates, textured assets) can run comp-first on a DeepInfra-only setup.

## Why an extension

pi's built-in image path is `codemode` → `models.generateImages()`, and it only speaks
`openrouter-images`: OpenRouter's *chat completions* endpoint with `modalities: ["image"]`.
DeepInfra serves images over `/v1/openai/images/generations` and `/v1/inference/<model>`,
and `models.json` has no way to declare an `image`-type model. So DeepInfra image models
cannot be reached through `models.generateImages()`; this extension registers a real tool
instead. `impeccable generate-image` (the skill's fallback CLI) is hardcoded to
`api.openai.com` with `OPENAI_API_KEY` and cannot be repointed.

## Install

```bash
pi install npm:pi-deepinfra-imagegen     # into ~/.pi/agent/settings.json
pi install -l npm:pi-deepinfra-imagegen  # or project-scoped .pi/settings.json
pi -e npm:pi-deepinfra-imagegen          # or try it for one run
```

Then restart pi or run `/reload`. The tool `generate_image` is active by default.
Updates: `pi update --extensions`. Removal: `pi remove npm:pi-deepinfra-imagegen`.

Credentials, resolved in order:

1. pi's credential store for the `deepinfra` provider — `/login deepinfra`, or the
   [`pi-deepinfra`](https://www.npmjs.com/package/pi-deepinfra) provider package
2. `DEEPINFRA_API_KEY`
3. `~/.pi/agent/auth.json` → `deepinfra.key`

## Tool

```
generate_image({
  prompt: "…",            // sent verbatim
  out: ".impeccable/mocks/comp-a.png",
  model: "google/nano-banana-pro",
  refs: [".impeccable/mocks/ref/home.png"],
  size: "1440x900",       // or "16:9", or "2K"
  transparent: false,     // true = generate, then Bria RMBG for real alpha
  seed: 7,
  count: 1,
  preview: true           // inline image in the result when the model takes images
})
```

It writes the image plus a prompt sidecar at `<out>.json`
(`{ prompt, model, size, refs, background, mimeType, costUsd, createdAt }`), preserving
an existing `"approved": true`. Impeccable's `build-phase advance` reads exactly that.

Details worth knowing:

- **Parameters are per-model.** The tool fetches the model's `in_schema` from the public
  DeepInfra API and sends only fields that model declares: `width`/`height`, `size`, or
  `aspect_ratio`; `image`, `image_urls`, or `input_image[_N]`. The catalog and per-model
  schemas are cached in `$PI_CODING_AGENT_DIR/cache/deepinfra-imagegen.json` (24 h;
  `/deepinfra-image refresh`).
- **Reference encoding differs.** Black Forest Labs models take raw base64 and reject data
  URLs; everything else takes data URLs. The tool picks the known encoding and retries the
  other once if the input is rejected.
- **Format honesty.** Some models ignore a PNG request (`sdxl-turbo`, `Seedream`, `Qwen`
  can return JPEG). The file is written with its true extension and the deviation is
  reported, instead of writing JPEG bytes into a `.png` path.
- **Presigned URLs.** BFL returns a presigned delivery URL; it is fetched without the
  API key (an extra `Authorization` header breaks the signature).
- Cost is DeepInfra's reported `inference_status.cost`, plus the Bria call when
  `transparent: true`.

## Command

`/deepinfra-image` lists image models with per-image price; `/deepinfra-image <model>`
sets the model for the session; `/deepinfra-image refresh` re-fetches the catalog.

Default model: `google/nano-banana-pro`. Good alternatives:

| Model | Use | Cost |
|---|---|---|
| `google/nano-banana-pro` | comps, type, edits, 1 reference | ~$0.13/image |
| `black-forest-labs/FLUX-2-pro` | up to 4 references, exact pixel size, PNG | $0.015–0.075 |
| `black-forest-labs/FLUX-2-klein-9b` | cheaper FLUX 2 | $0.014 |
| `ByteDance/Seedream-4` | fast 2K/4K, 1 reference | $0.04 |
| `stabilityai/sdxl-turbo` | drafts only, weak prompt adherence | $0.0002 |
| `Bria/remove_background` | used internally for `transparent: true` | $0.018 |

Models that return PNG natively: nano-banana-pro, FLUX (`output_format: png` is forced),
Bria. For Impeccable **plates** (PNG required), prefer those, or `transparent: true`,
which always lands on a PNG.

## Using it with Impeccable comp-first

1. Ensure the extension is loaded (`generate_image` in the tool list) and the session
   model accepts image input, so the model can actually look at comps it generates
   (DeepInfra `vision`-tagged models, e.g. `deepseek-ai/DeepSeek-V4.1-Flash`).
2. `$impeccable init` then the normal new-work flow: when it asks comp-first vs
   code-first, choose comp-first.
3. The tool's `promptGuidelines` tell the model that `generate_image` is this harness's
   image tool, so Impeccable treats image generation as available even though
   `impeccable context` prints no `IMAGE_GEN_AVAILABLE` line (that line keys off
   `OPENAI_API_KEY`, which this setup does not need).
4. Comps: `generate_image` to `.impeccable/mocks/<name>.png` with `refs` pointing at a
   representative existing page when the project has an established identity.
5. Plates: the asset producer passes the comp crop as `refs[0]`, and `transparent: true`
   for cutouts.
6. After approving a comp, set `"approved": true` in `<comp>.json`.

## Development

No build step; the TypeScript file is loaded directly.

```bash
pi -e ./            # load this checkout for one run
npm pack --dry-run  # inspect what would be published
```

## License

MIT
